// Synthetic source, mock ASR/model callbacks and the ordinary Studio UI only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';
import { readProductTranscript, transcribeProductSource } from './product-transcription.mjs';

test('ordinary UI reviews two transcript seams, preserves drafts on save failure and reopens local corrections without service requests', { timeout: 180000 }, async () => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/transcript-seams-20261104/browser');
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'flow-'));
  const envNames = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK'];
  const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  for (const name of envNames.slice(0, 3)) process.env[name] = join(scratch, name);
  process.env.DAOCUT_NO_UPDATE_CHECK = '1';
  await mkdir(process.env.DAOCUT_TRASH_DIR);
  let studio, browser, context, page, step = 'fixture';
  const calls = { asr: 0, model: 0 };
  const start = () => startStudio({ port: 0, ...(process.env.DAOCUT_TRANSCRIPTION_UI ? { editorDir: resolve(process.env.DAOCUT_TRANSCRIPTION_UI) } : {}), openBrowser: () => {}, requireAnalysisPlan: true,
    analysisServices: async () => ({ transcription: { enabled: false, provider: 'synthetic', model: 'mock', endpoint: 'local://mock/asr' }, text: { enabled: true, provider: 'synthetic', model: 'mock', endpoint: 'local://mock/text' } }),
    liveAnalysis: { modelIdentity: 'synthetic-seam-model-v1', modelClient: async ({ input }) => {
      calls.model++;
      const data = JSON.parse(input);
      return { candidates: [{ firstCue: 0, lastCue: data.cues.length - 1, tags: ['卖点'], details: { subtypes: [], reason: '隔离接缝回归', evidence: ['ASR'], context: '', repetition: '', review: ['合成数据，画面未核实'] } }], issues: [] };
    } },
    productDiscovery: { modelIdentity: 'synthetic-unused-discovery', modelClient: async () => { calls.model++; throw new Error('Opening and cancelling a plan must never invoke a model'); } },
  });
  try {
    studio = await start();
    const api = async (path, method = 'GET', body, expected = 200) => {
      const response = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const value = await response.json(); assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`); return value;
    };
    const { project } = await api('/api/projects', 'POST', { path: join(scratch, 'synthetic-seams') });
    const endpoint = `/api/projects/${project.id}`;
    const source = { id: 'synthetic-seam-source', assetPath: 'assets/synthetic-seams.mp4', durationMs: 18000 };
    await mkdir(join(project.path, 'assets'), { recursive: true });
    const videoPath = join(project.path, source.assetPath);
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=18', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=18', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', videoPath], { windowsHide: true });
    const analysis = { version: 1, sources: [source], products: [{ id: 'manual-product', name: '人工商品名保留', sourceIds: [source.id] }], intervals: [{ id: 'manual-range', productId: 'manual-product', sourceId: source.id, startMs: 0, endMs: 18000 }], candidates: [] };
    await api(`${endpoint}/product-analysis`, 'PUT', { analysis });
    const rows = [
      [{ text: '合成开场', startMs: 200, endMs: 1000 }, { text: '前段截断因为', startMs: 5800, endMs: 6800 }],
      [{ text: '后段完整因为可以继续', startMs: 700, endMs: 1800 }, { text: '合成中段', startMs: 3000, endMs: 4000 }, { text: '价格是1.2元', startMs: 6800, endMs: 7800 }],
      [{ text: '价格是12元', startMs: 700, endMs: 1800 }, { text: '合成结尾', startMs: 3000, endMs: 4000 }],
    ];
    await assert.rejects(transcribeProductSource(project.path, source, { audioPolicy: { targetMs: 6000, overlapMs: 2000 }, getKey: async () => 'synthetic-key-never-sent', readAudio: async (_path, _signal, range) => Buffer.from(range.id), runProvider: async (_verb, _args, ctx) => {
      calls.asr++; const id = Number((await ctx.read()).toString().split('-')[1]) - 1, cues = rows[id];
      return { index: [{ text: cues.map(c => c.text).join(''), cues, words: cues.map(c => ({ token: c.text, start: c.startMs / 1000, end: c.endMs / 1000 })) }] };
    } }), error => error.code === 'ASR_BOUNDARY_REVIEW');
    assert.deepEqual(calls, { asr: 3, model: 0 });
    const key = createHash('sha256').update(source.id).digest('hex');
    const manifestPath = join(project.path, '.film', 'product-transcripts', `${key}.json.segments.json`);
    const takeState = await api(`${endpoint}/source-takes?sourceId=${source.id}`);
    await api(`${endpoint}/source-takes?sourceId=${source.id}`, 'PUT', { sourceId: source.id, expectedRevision: takeState.revision, sourceIdentity: takeState.sourceIdentity, document: { version: 1, sourceId: source.id, assetPath: source.assetPath, durationMs: source.durationMs, signature: JSON.stringify([source.assetPath, source.durationMs, []]), film: { tracks: [{ clips: [{ id: 'manual-take', src: source.assetPath, at: 2, time: [2, 3], attrs: { 'data-source-kind': 'context' } }] }] } } });
    const protectedPaths = [videoPath, join(project.path, 'film.html'), manifestPath, join(project.path, '.film', 'source-takes.json')];
    const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
    const protectedBefore = await Promise.all(protectedPaths.map(hash));
    const baselineAnalysis = await readFile(join(project.path, '.film', 'product-analysis.json'), 'utf8');
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const open = async () => {
      context = await browser.newContext({ viewport: { width: 1680, height: 1120 } });
      const allowed = new Set([studio.origin, studio.filmOrigin]);
      await context.route('**/*', route => allowed.has(new URL(route.request().url()).origin) ? route.continue() : route.abort());
      page = await context.newPage(); page.setDefaultTimeout(12000);
      await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
      await page.getByRole('button', { name: '商品与结构', exact: true }).click();
      const preparationDetails = page.getByLabel('直播拆品设置', { exact: true });
      if (!await preparationDetails.evaluate(element => element.open)) await preparationDetails.locator(':scope > summary').click();
      await page.getByRole('button', { name: '核对字幕接缝', exact: true }).click();
      await page.getByRole('region', { name: '字幕接缝核对', exact: true }).waitFor();
    };
    const panel = () => page.getByRole('region', { name: '字幕接缝核对', exact: true });
    const current = () => api(`${endpoint}/transcript-review?sourceId=${source.id}`);
    const waitReview = async predicate => {
      for (let n = 0; n < 60; n++) { const review = await current(); if (predicate(review)) return review; await page.waitForTimeout(100); }
      assert.fail('local review did not persist expected state');
    };
    const acknowledge = async () => {
      const checkbox = panel().getByRole('checkbox', { name: '已知悉字幕修改影响', exact: true });
      if (await checkbox.count()) await checkbox.check();
    };
    step = 'ordinary panel exposes two unresolved seams';
    await open();
    let review = await current();
    assert.equal(review.pendingCount, 2);
    assert.equal(review.seams.length, 2);
    assert.deepEqual(calls, { asr: 3, model: 0 });
    const firstId = review.seams[0].id, secondId = review.seams[1].id;
    await panel().getByLabel('选择接缝', { exact: true }).selectOption(firstId);
    step = 'absolute-time original preview at the first seam';
    await panel().getByRole('button', { name: '播放接缝原片', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.offsetWidth && video.currentTime >= 2 && video.currentTime < 9 && !video.paused));
    await page.evaluate(() => [...document.querySelectorAll('video')].forEach(video => video.pause()));
    await panel().getByRole('button', { name: '定位后段字幕 1', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.offsetWidth && !video.seeking && Math.abs(video.currentTime - 5.7) < 0.25));
    await panel().getByRole('button', { name: '采用后段', exact: true }).click();
    assert.equal(await panel().getByLabel('字幕文字 1', { exact: true }).inputValue(), '后段完整因为可以继续');
    await acknowledge();
    await panel().getByRole('button', { name: '确认并保存接缝', exact: true }).click();
    review = await waitReview(value => value.pendingCount === 1);
    assert.equal(review.seams.find(item => item.id === firstId).status, 'confirmed');
    await assert.rejects(readProductTranscript(project.path, source), 'one unresolved seam is not a complete transcript');
    assert.deepEqual(calls, { asr: 3, model: 0 });
    step = 'fresh browser and isolated server preserve the first confirmation';
    await context.close(); context = null; await studio.close(); studio = await start();
    await open(); review = await current();
    assert.equal(review.pendingCount, 1);
    assert.equal(review.seams.find(item => item.id === firstId).status, 'confirmed');
    await panel().getByLabel('选择接缝', { exact: true }).selectOption(secondId);
    await panel().getByRole('button', { name: '采用前段', exact: true }).click();
    await panel().getByLabel('字幕文字 1', { exact: true }).fill('人工核对后：价格是1.2元');
    await panel().getByLabel('开始秒 1', { exact: true }).fill('11.8');
    await panel().getByLabel('结束秒 1', { exact: true }).fill('12.8');
    await panel().getByRole('button', { name: '定位最终字幕 1', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.offsetWidth && !video.seeking && Math.abs(video.currentTime - 11.8) < 0.25));
    await acknowledge();
    step = 'a failed local save retains the edited draft and never resubmits ASR';
    let blockSave = true;
    await page.route('**/transcript-review', route => route.request().method() === 'PUT' && blockSave ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '隔离测试：本地保存失败' }) }) : route.continue());
    await panel().getByRole('button', { name: '确认并保存接缝', exact: true }).click();
    await panel().getByText(/隔离测试：本地保存失败/).waitFor();
    assert.equal(await panel().getByLabel('字幕文字 1', { exact: true }).inputValue(), '人工核对后：价格是1.2元');
    assert.equal((await current()).pendingCount, 1);
    assert.deepEqual(calls, { asr: 3, model: 0 });
    blockSave = false;
    await panel().getByRole('button', { name: '确认并保存接缝', exact: true }).click();
    review = await waitReview(value => value.pendingCount === 0);
    const transcript = await readProductTranscript(project.path, source);
    assert.ok(transcript.cues.some(cue => cue.text === '人工核对后：价格是1.2元' && cue.startMs === 11800 && cue.endMs === 12800));
    assert.equal(await readFile(join(project.path, '.film', 'product-analysis.json'), 'utf8'), baselineAnalysis, 'subtitle corrections preserve manual products and lecture ranges');
    assert.deepEqual(await Promise.all(protectedPaths.map(hash)), protectedBefore, 'local seam correction alone never changes original manifest, video, film or private takes');
    const preparation = await api(`${endpoint}/product-workflow/status?sourceId=${source.id}`);
    assert.equal(preparation.transcription.status, 'complete');
    assert.equal(preparation.ready, true);
    assert.equal(preparation.discoveryReady, false);
    assert.equal(preparation.discovery.status, 'idle');
    await page.getByRole('region', { name: '原视频转写', exact: true }).getByRole('button', { name: /^继续拆品/ }).waitFor();
    assert.deepEqual(calls, { asr: 3, model: 0 });
    step = 'an explicitly requested mock structure becomes stale after local subtitle revision';
    const plan = await api(`${endpoint}/product-workflow/plan?sourceId=${source.id}&action=analysis&productId=manual-product&intervalId=manual-range`);
    await api(`${endpoint}/product-workflow/execute`, 'POST', { confirmed: true, plan });
    let live;
    for (let n = 0; n < 60; n++) { live = await api(`${endpoint}/live-analysis?sourceId=${source.id}&productId=manual-product&intervalId=manual-range`); if (live.analysis.status === 'complete') break; await page.waitForTimeout(100); }
    assert.equal(live.analysis.status, 'complete'); assert.deepEqual(calls, { asr: 3, model: 1 });
    const afterModel = await readFile(join(project.path, '.film', 'product-analysis.json'), 'utf8');
    await context.close(); context = null; await open();
    await page.locator('[data-product-card="manual-product"]').getByRole('button', { name: /^重新分析 / }).waitFor();
    await panel().getByLabel('选择接缝', { exact: true }).selectOption(secondId);
    await panel().getByLabel('字幕文字 1', { exact: true }).fill('人工再次核对：价格是1.2元');
    await acknowledge();
    const revision = (await current()).revision;
    await panel().getByRole('button', { name: '确认并保存接缝', exact: true }).click();
    review = await waitReview(value => value.revision > revision);
    live = await api(`${endpoint}/live-analysis?sourceId=${source.id}&productId=manual-product&intervalId=manual-range`);
    assert.equal(live.analysis.stale, true);
    await page.locator('[data-product-card="manual-product"]').getByRole('button', { name: /^分析 / }).waitFor();
    assert.deepEqual(calls, { asr: 3, model: 1 }, 'review changes do not request ASR or reanalysis');
    assert.equal(await readFile(join(project.path, '.film', 'product-analysis.json'), 'utf8'), afterModel, 'old candidates and human edits remain saved');
    step = 'final reopening preserves edited transcript and all original files';
    await context.close(); context = null; await studio.close(); studio = await start(); await open();
    await panel().getByLabel('选择接缝', { exact: true }).selectOption(secondId);
    assert.equal(await panel().getByLabel('字幕文字 1', { exact: true }).inputValue(), '人工再次核对：价格是1.2元');
    assert.equal((await current()).pendingCount, 0);
    assert.deepEqual(calls, { asr: 3, model: 1 });
    assert.deepEqual(await Promise.all(protectedPaths.slice(0, 3).map(hash)), protectedBefore.slice(0, 3));
    const finalTakes = await api(`${endpoint}/source-takes?sourceId=${source.id}`);
    const manualTake = finalTakes.document.film.tracks.flatMap(track => track.clips).find(clip => clip.id === 'manual-take');
    assert.deepEqual(manualTake?.time, [2, 3], 'new AI candidates may update the baseline, but the manual take remains unchanged');
    step = 'a background read cannot rebase a dirty draft over another window';
    await panel().getByLabel('选择接缝', { exact: true }).selectOption(firstId);
    await panel().getByLabel('字幕文字 1', { exact: true }).fill('本窗口尚未保存的草稿');
    const concurrentBase = await current();
    const otherWindow = await api(`${endpoint}/transcript-review`, 'PUT', { sourceId: source.id, identity: concurrentBase.identity, expectedRevision: concurrentBase.revision, seamId: firstId,
      cues: [{ ...concurrentBase.seams.find(item => item.id === firstId).resolved[0], text: '其他窗口已确认的文字' }], confirmed: true, acknowledgeImpact: true });
    const advanced = page.getByLabel('拆品高级操作', { exact: true });
    if (!await advanced.evaluate(element => element.open)) await advanced.locator(':scope > summary').click();
    await advanced.getByRole('button', { name: '识别多商品', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '确认拆品', exact: true });
    const backgroundRead = page.waitForResponse(response => response.request().method() === 'GET' && response.url().includes('/transcript-review?'));
    await confirmation.getByRole('button', { name: /^(取消|返回任务状态)$/ }).click();
    assert.equal((await (await backgroundRead).json()).revision, otherWindow.revision);
    assert.equal(await panel().getByLabel('字幕文字 1', { exact: true }).inputValue(), '本窗口尚未保存的草稿');
    await acknowledge();
    const conflictResponse = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/transcript-review'));
    await panel().getByRole('button', { name: '确认并保存接缝', exact: true }).click();
    const conflictStatus = (await conflictResponse).status();
    if (conflictStatus === 409) {
      await panel().getByRole('alert').waitFor();
      assert.equal(await panel().getByLabel('字幕文字 1', { exact: true }).inputValue(), '本窗口尚未保存的草稿');
      assert.equal((await current()).seams.find(item => item.id === firstId).resolved[0].text, '其他窗口已确认的文字');
      step = 'background reads keep conflict recovery visible until explicit reload';
      await advanced.getByRole('button', { name: '识别多商品', exact: true }).click();
      const conflictRead = page.waitForResponse(response => response.request().method() === 'GET' && response.url().includes('/transcript-review?'));
      await page.getByRole('dialog', { name: '确认拆品', exact: true }).getByRole('button', { name: /^(取消|返回任务状态)$/ }).click();
      assert.equal((await (await conflictRead).json()).revision, otherWindow.revision);
      await page.waitForTimeout(150);
      assert.equal(await panel().getByRole('button', { name: '重新读取接缝', exact: true }).isVisible(), true, 'conflicted drafts retain their explicit recovery action after background reads');
      assert.equal(await panel().getByLabel('字幕文字 1', { exact: true }).inputValue(), '本窗口尚未保存的草稿');
      await panel().getByRole('button', { name: '重新读取接缝', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('textarea[aria-label="字幕文字 1"]')?.value === '其他窗口已确认的文字');
      assert.equal(await panel().getByRole('alert').count(), 0, 'explicit reload resolves the conflict and clears its old error');
    }
    step = 'confirming no valid subtitle at one seam keeps the other transcript cues';
    await context.close(); context = null; await open();
    await panel().getByLabel('选择接缝', { exact: true }).selectOption(firstId);
    while (await panel().getByRole('button', { name: '移除最终字幕 1', exact: true }).count()) await panel().getByRole('button', { name: '移除最终字幕 1', exact: true }).click();
    await acknowledge();
    const emptyResponse = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/transcript-review'), { timeout: 2000 }).catch(() => null);
    await panel().getByRole('button', { name: '确认并保存接缝', exact: true }).click();
    const emptyStatus = (await emptyResponse)?.status() ?? null;
    if (emptyStatus === 200) {
      assert.deepEqual((await current()).seams.find(item => item.id === firstId).resolved, []);
      const withoutFirstSeam = await readProductTranscript(project.path, source);
      assert.ok(withoutFirstSeam.cues.some(cue => cue.text === '合成开场'));
      assert.ok(withoutFirstSeam.cues.some(cue => cue.text === '人工再次核对：价格是1.2元'));
      await context.close(); context = null; await studio.close(); studio = await start(); await open();
      await panel().getByLabel('选择接缝', { exact: true }).selectOption(firstId);
      assert.equal(await panel().getByLabel('字幕文字 1', { exact: true }).count(), 0, 'empty confirmation survives reopening');
      assert.deepEqual((await current()).seams.find(item => item.id === firstId).resolved, []);
    }
    assert.deepEqual({ conflictStatus, emptyStatus }, { conflictStatus: 409, emptyStatus: 200 });
    assert.deepEqual(calls, { asr: 3, model: 1 });
    await panel().getByLabel('选择接缝', { exact: true }).selectOption(secondId);
    await panel().getByLabel('字幕文字 1', { exact: true }).click();
    await page.screenshot({ path: join(base, 'seams-reviewed.png') });
    await writeFile(join(base, 'result.json'), JSON.stringify({ synthetic: true, mockFixtureAsr: 3, explicitMockStructure: 1, reviewServiceRequests: 0, twoSeams: true, partialSaveReopen: true, failedSavePreservesDraft: true, correctedTextAndAbsoluteTimes: true, staleAnalysisWithoutOverwrite: true, originalManifestVideoAndFilmUnchanged: true, privateTakeRangePreserved: true, dirtyDraftRejectsConcurrentOverwrite: true, emptySeamConfirmationReopens: true }, null, 2));
  } catch (error) {
    error.message = `[${step}] ${error.message}`;
    await page?.screenshot({ path: join(base, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await context?.close().catch(() => {}); await browser?.close().catch(() => {}); await studio?.close().catch(() => {});
    for (const name of envNames) previousEnv[name] === undefined ? delete process.env[name] : process.env[name] = previousEnv[name];
    const rel = relative(base, scratch); assert.ok(rel && rel !== '..' && !rel.startsWith('..') && !isAbsolute(rel));
    await rm(scratch, { recursive: true, force: true });
  }
});
