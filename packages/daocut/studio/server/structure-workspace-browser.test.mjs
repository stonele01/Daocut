// Isolated browser acceptance: generated 16-second media, simulated public plans,
// mocked local media-review responses, real private-project creation and workspace
// persistence. No model/NAS/export; the media tool itself is tested separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';
import { openProject } from './projects.mjs';
import { ensureStructureDraft, listStructureDrafts } from './structure-drafts.mjs';
import { writeProjectFilm } from './film.mjs';
import { createLiveAnalysis } from './live-analysis.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const protectedPaths = ['film.html', 'assets/synthetic-live.mp4', 'assets/synthetic-live.vtt', '.film/product-analysis.json', '.film/settings.json', '.film/subtitles.json'];
async function snapshot(root) { return Object.fromEntries(await Promise.all(protectedPaths.map(async path => [path, digest(await readFile(join(root, path)))]))); }

test('structure UI previews without mutation and preserves independent drafts through switching/reload', { timeout: 90000 }, async () => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/structure-feature/browser');
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'workspace-'));
  const environment = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK', 'TEMP', 'TMP'];
  const previous = Object.fromEntries(environment.map(name => [name, process.env[name]]));
  process.env.DAOCUT_STUDIO_HOME = join(scratch, 'home');
  process.env.DAOCUT_LIBRARY = join(scratch, 'library');
  process.env.DAOCUT_TRASH_DIR = join(scratch, 'trash');
  process.env.DAOCUT_NO_UPDATE_CHECK = '1';
  process.env.TEMP = join(scratch, 'temp'); process.env.TMP = join(scratch, 'temp');
  await mkdir(process.env.TEMP, { recursive: true });
  await mkdir(process.env.DAOCUT_TRASH_DIR, { recursive: true });
  let studio, browser;
  const attemptedModels = [], browserErrors = [], created = new Map();
  try {
    studio = await startStudio({ port: 0, ...(process.env.DAOCUT_STRUCTURE_UI ? { editorDir: resolve(process.env.DAOCUT_STRUCTURE_UI) } : {}), openBrowser: () => {}, authorizeTask: async () => { attemptedModels.push('server-authorize'); throw Error('No external task is allowed in this browser fixture'); } });
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json(); assert.equal(response.status, 200, `${path}: ${JSON.stringify(value)}`); return value;
    };
    const { project } = await api('/api/projects', 'POST', { path: join(scratch, 'synthetic-parent') });
    await mkdir(join(project.path, 'assets'), { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x160:rate=10:duration=16', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=16', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', join(project.path, 'assets/synthetic-live.mp4')], { windowsHide: true });
    await writeFile(join(project.path, 'assets/synthetic-live.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n这是合成钩子甲\n\n00:00:04.000 --> 00:00:07.000\n这是合成核心购买理由\n\n00:00:08.000 --> 00:00:10.000\n这是合成钩子乙\n\n00:00:12.000 --> 00:00:14.000\n需要的点击购买\n');
    const scope = { sourceId: 's', productId: 'p', intervalId: 'i', startMs: 0, endMs: 16000 };
    const clips = [
      { candidateId: 'h-a', sourceId: 's', assetPath: 'assets/synthetic-live.mp4', startMs: 0, endMs: 2000, text: '这是合成钩子甲', roles: ['hook'], coreIds: [] },
      { candidateId: 'core', sourceId: 's', assetPath: 'assets/synthetic-live.mp4', startMs: 4000, endMs: 7000, text: '这是合成核心购买理由', roles: ['core'], coreIds: ['synthetic-core'] },
      { candidateId: 'close', sourceId: 's', assetPath: 'assets/synthetic-live.mp4', startMs: 12000, endMs: 14000, text: '需要的点击购买', roles: ['purchase'], coreIds: [] },
    ];
    const plans = [
      { id: 'synthetic-plan-a', version: 'fixture-v1', scope, speed: 1, durationMs: 7000, coreIds: ['synthetic-core'], coreLabels: { 'synthetic-core': '合成核心购买理由' }, clips },
      { id: 'synthetic-plan-b', version: 'fixture-v1', scope, speed: 1, durationMs: 7000, coreIds: ['synthetic-core'], coreLabels: { 'synthetic-core': '合成核心购买理由' }, clips: [{ ...clips[0], candidateId: 'h-b', startMs: 8000, endMs: 10000, text: '这是合成钩子乙' }, clips[1], clips[2]] },
    ];
    const mediaReviewFixture = {
      version: 'product-media-review-v1', key: 'synthetic-media-review', status: 'complete',
      scope: { startMs: 0, endMs: 16000 },
      segments: [{
        startMs: 4000, endMs: 7000, cueRange: [1, 1],
        visual: { status: 'sampled', sampleTimesMs: [4000, 5500, 6900] },
        audio: { status: 'technical-checked', hasAudio: true, peakDb: -8, integratedLufs: -20.3, measurementRange: { startMs: 0, endMs: 16000 } },
        issues: [],
      }],
      issues: [], speechVerified: false, continuousActionVerified: false,
    };
    let savedMediaReview, mediaReviewRequests = 0, mediaReviewReads = 0;
    let savedVisualReview, visualReviewRequests = 0, visualPlanReads = 0;
    let visualPlanFixture;
    const visualIdentity = { id: 'synthetic-vision', name: '模拟看图服务', model: 'simulated-vision', provider: 'mock', endpoint: 'https://model.invalid/vision' };
    const visualReviewFixture = { version: 'product-visual-review-v1', status: 'complete', scope: { startMs: 0, endMs: 16000 }, entries: [{ startMs: 4000, endMs: 7000, cueRange: [1, 1], productMatch: 'match', display: 'shown', evidenceTimesMs: [4000, 5500], observation: '模拟画面中可见合成商品', issues: ['此结果为隔离模拟，不是真实看图判断'] }], issues: [], speechVerified: false, continuousActionVerified: false };
    const liveAnalysisState = () => ({
      transcription: { status: 'complete', segments: [] }, canReviewMedia: !savedMediaReview,
      analysis: { status: 'complete', intervalId: 'i', productId: 'p', rangeStartMs: 0, rangeEndMs: 16000, stale: false, currentRunId: 'synthetic-analysis', ...(savedMediaReview ? { mediaReview: savedMediaReview } : {}), ...(savedVisualReview ? { visualReview: savedVisualReview, localVisualReview: true } : {}) },
    });
    const analysis = { version: 1, sources: [{ id: 's', assetPath: 'assets/synthetic-live.mp4', durationMs: 16000 }], products: [{ id: 'p', name: '隔离合成商品', sourceIds: ['s'] }], intervals: [{ id: 'i', sourceId: 's', productId: 'p', startMs: 0, endMs: 16000 }], candidates: [clips[0], clips[1], plans[1].clips[0], clips[2]].map((clip, index) => ({ id: clip.candidateId, ...clip, productId: 'p', intervalId: 'i', cueRange: [index, index], tags: clip.roles.map(role => ({ hook: '钩子', core: '卖点', purchase: '行动指令' })[role]), origin: 'synthetic-test', version: 1 })) };
    await api(`/api/projects/${project.id}/product-analysis`, 'PUT', { analysis });
    await writeProjectFilm(project.path, { stage: { w: 96, h: 160 }, tracks: [{ clips: [{ id: 'existing-film', src: 'assets/synthetic-live.mp4', at: 0, time: [14, 15] }] }] });
    await api(`/api/projects/${project.id}/settings`, 'PATCH', { fps: 30 });
    await api(`/api/projects/${project.id}/subtitles`, 'PUT', { style: { on: true } });
    const parentBefore = await snapshot(project.path);

    // A separate synthetic source feeds the actual live-analysis GET route. Only
    // model/tool adapters are mocked: no hand-built UI plan can hide API drift.
    const visualRoot = join(scratch, 'visual-plan-contract');
    await mkdir(join(visualRoot, 'assets'), { recursive: true }); await mkdir(join(visualRoot, '.film'), { recursive: true });
    await writeFile(join(visualRoot, 'assets/synthetic-live.mp4'), 'isolated visual-plan synthetic source');
    await writeFile(join(visualRoot, '.film/product-analysis.json'), JSON.stringify({ ...analysis, candidates: [] }));
    const visualLive = createLiveAnalysis({
      modelIdentity: 'synthetic-text', probeSource: async () => ({ duration: 16 }),
      readTranscript: async () => ({ cues: analysis.candidates.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })), words: [] }),
      modelClient: async () => ({ schema: 'complete-speech-v1', candidates: analysis.candidates.map((candidate, index) => ({ firstCue: index, lastCue: index, tags: candidate.tags })), issues: [] }),
      mediaReview: async () => ({ ...mediaReviewFixture, key: 'a'.repeat(64), sourceSha: 'b'.repeat(64) }),
      visualReview: { identity: async () => visualIdentity, review: async () => ({ ...visualReviewFixture, status: 'uncertain', entries: [], issues: ['模拟先前看图请求状态不明'] }) },
    });
    await visualLive.startAnalysis(visualRoot, { ...scope, lectureOnly: true, expectedVisualIdentity: visualIdentity });
    await visualLive.wait(visualRoot, scope.sourceId);
    const preparedVisualState = await visualLive.view(visualRoot, scope.sourceId, scope.intervalId, scope.productId, scope);
    assert.equal(preparedVisualState.analysis.status, 'complete');
    assert.equal(preparedVisualState.analysis.visualReview.status, 'uncertain');

    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    // This is the documented embedded-host contract, not a native desktop process.
    await page.addInitScript(() => {
      const listeners = new Set();
      const panel = {
        label: '模拟宿主AI对话', open: true, width: 350,
        setOpen(open) { panel.open = open; const element = document.querySelector('[data-studio-host-panel]'); if (element) element.hidden = !open; for (const listener of listeners) listener({ open, width: panel.width }); },
        setWidth(width) { panel.width = width; for (const listener of listeners) listener({ open: panel.open, width }); },
        onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      };
      window.daocutHost = { version: 1, name: '隔离模拟宿主', panel };
      document.addEventListener('DOMContentLoaded', () => {
        const element = document.createElement('aside'); element.dataset.studioHostPanel = ''; element.setAttribute('aria-label', '模拟宿主AI对话'); element.textContent = '仅验证宿主面板开关，没有真实模型或聊天请求'; element.hidden = !panel.open;
        element.style.cssText = 'position:fixed;right:8px;top:40px;bottom:8px;width:334px;background:#181818;color:#ddd;padding:20px;z-index:45';
        document.body.append(element);
      }, { once: true });
    });
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => browserErrors.push(error.message));
    const writes = [];
    page.on('request', request => { if (request.method() !== 'GET') writes.push({ method: request.method(), url: request.url(), at: Date.now() }); });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (![studio.origin, studio.filmOrigin].includes(url.origin)) return route.abort();
      if (request.method() === 'POST' && /\/(?:live-analysis\/(?:analyze|transcribe)|product-workflow\/execute|subtitles\/(?:transcribe|translate)|turns|chat|exports)(?:\/|$)/.test(url.pathname)) {
        attemptedModels.push(url.pathname); return route.fulfill({ status: 409, json: { error: 'Models/exports disabled in fixture' } });
      }
      return route.continue();
    });
    await page.route('**/product-workflow/plan**', route => route.fulfill({ json: { identity: 'synthetic-workflow-plan', ...scope, action: 'analysis', rerun: true, source: { assetPath: 'assets/synthetic-live.mp4', durationMs: 16000 }, scope, service: { enabled: true, name: '模拟文字服务', model: 'simulated-text', provider: 'mock', endpoint: 'https://model.invalid/text' }, enabled: true, cached: false, requestCount: 3, totalRequests: 3, reusedRequests: 0, transcriptSegments: 4, cost: { estimate: null, basis: '隔离模拟请求计划', uncertain: true }, retryRequired: false, visual: { ...visualIdentity, enabled: true, identity: { model: 'simulated-vision' }, requestCount: 1, maxImages: 1 } } }));
    await page.route('**/live-analysis**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === 'GET' && path.endsWith('/live-analysis/visual-plan')) {
        visualPlanReads += 1;
        const req = Readable.from([]); req.method = 'GET'; req.url = route.request().url();
        let code, value;
        const res = { writeHead(status) { code = status; }, end(text) { value = JSON.parse(text); } };
        assert.equal(await visualLive(req, res, visualRoot, 'live-analysis/visual-plan'), true);
        assert.equal(code, 200); assert.equal(value.service.model, visualIdentity.model);
        visualPlanFixture = value;
        return route.fulfill({ status: code, json: value });
      }
      if (route.request().method() === 'POST' && path.endsWith('/live-analysis/review-visual')) {
        assert.deepEqual(route.request().postDataJSON(), { confirmed: true, plan: visualPlanFixture, retryAcknowledged: true }, 'only the explicitly confirmed exact visual plan may be submitted');
        visualReviewRequests += 1; savedVisualReview = visualReviewFixture;
        return route.fulfill({ json: liveAnalysisState() });
      }
      if (route.request().method() === 'POST' && new URL(route.request().url()).pathname.endsWith('/live-analysis/review-media')) {
        assert.deepEqual(route.request().postDataJSON(), { ...scope, confirmed: true }, 'explicit media check is scoped to this one lecture');
        mediaReviewRequests += 1; savedMediaReview = mediaReviewFixture;
        return route.fulfill({ json: liveAnalysisState() });
      }
      if (route.request().method() !== 'GET') { attemptedModels.push(route.request().url()); return route.fulfill({ status: 409, json: { error: 'No model request may be attempted' } }); }
      if (savedMediaReview) mediaReviewReads += 1;
      return route.fulfill({ json: liveAnalysisState() });
    });
    await page.route('**/structure-plans**', route => route.fulfill({ json: { status: 'complete', taskKey: 'synthetic-public-task', context: { ...scope, visibility: 'shared' }, plans, complete: true, materialComplete: true, allValidCombinationsEnumerated: true, issues: [], requestCount: 0, ...(savedMediaReview ? { mediaReview: savedMediaReview, mediaReviewOrigin: 'local' } : {}), ...(savedVisualReview ? { visualReview: savedVisualReview, visualReviewOrigin: 'local' } : {}) } }));
    await page.route('**/structure-drafts', async route => {
      try {
        const body = route.request().postDataJSON(), plan = plans.find(item => item.id === body.planId);
        assert.ok(plan, 'only the displayed simulated public plans may be opened');
        const draft = await ensureStructureDraft(project.path, { parentProjectId: project.id, plan });
        const child = await openProject(draft.root);
        created.set(plan.id, { ...draft, project: child });
        await route.fulfill({ json: { project: child, meta: draft.meta } });
      } catch (error) { browserErrors.push(error.message); await route.fulfill({ status: 500, json: { error: error.message } }); }
    });

    await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
    const productMode = page.getByRole('button', { name: '商品与结构', exact: true });
    if (await productMode.count()) await productMode.click();
    const productCard = page.locator('[data-product-card="p"]');
    await productCard.waitFor();
    assert.equal(await page.evaluate(() => window.daocutHost.panel.open), true, 'entering a project preserves the original chat layout');
    await page.locator('summary').filter({ hasText: /^分析详情$/ }).click();
    const analysisMediaReview = page.locator('details[aria-label="已保存的音画核查"]');
    await analysisMediaReview.getByText('音画核查：未保存记录', { exact: true }).waitFor();
    await analysisMediaReview.locator('summary').click();
    await analysisMediaReview.getByText('沿用已有文字结果，未自动补查音画。', { exact: true }).waitFor();
    assert.equal(mediaReviewRequests, 0, 'reading old analysis never starts media tools or a model');
    const mediaRefresh = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname.endsWith('/live-analysis') && !!savedMediaReview);
    await page.getByRole('button', { name: '核查画面与声音', exact: true }).click();
    await mediaRefresh;
    await analysisMediaReview.getByText('音画工具结果已保存', { exact: true }).waitFor();
    assert.equal(mediaReviewRequests, 1);
    assert.ok(mediaReviewReads >= 1, 'the UI refreshes saved analysis after the explicit local check');
    if (await analysisMediaReview.getAttribute('open') === null) await analysisMediaReview.locator('summary').click();
    await analysisMediaReview.getByText('原片范围：00:00–00:16', { exact: true }).waitFor();
    await analysisMediaReview.getByText('00:04–00:07', { exact: true }).waitFor();
    await analysisMediaReview.getByText('音频技术检查：本次讲解整体测量（00:00–00:16） · 峰值 -8 dB · 综合响度 -20.3 LUFS', { exact: true }).waitFor();
    assert.doesNotMatch(await analysisMediaReview.innerText(), /复用公共音画记录/, 'a newly saved local check is not described as a public result');
    await page.getByRole('button', { name: '重新分析结构', exact: true }).click();
    const workflowDialog = page.getByRole('dialog', { name: '确认分析', exact: true });
    await workflowDialog.getByText('其中：文字分析 2 次 ＋ AI 看图 1 次', { exact: true }).waitFor();
    await workflowDialog.getByText('画面发送至：https://model.invalid/vision', { exact: true }).waitFor();
    assert.match(await workflowDialog.innerText(), /看图请求可能计费/);
    assert.match(await workflowDialog.innerText(), /本讲解抽帧与对应原话/);
    await workflowDialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(visualReviewRequests, 0, 'the text workflow confirmation never sends a request by merely opening');
    const analysisVisualReview = page.locator('details[aria-label="已保存的 AI 看图核查"]');
    await analysisVisualReview.getByText('AI 看图：未保存记录', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'AI 看图核查', exact: true }).click();
    const visualDialog = page.getByRole('dialog', { name: '确认 AI 看图核查', exact: true });
    await visualDialog.getByText('预计新增请求：文字分析 0 次 ＋ AI 看图 1 次 · 最多 1 张拼图', { exact: true }).waitFor();
    await visualDialog.getByText('看图服务：模拟看图服务 · simulated-vision', { exact: true }).waitFor();
    await visualDialog.getByText('发送至：https://model.invalid/vision', { exact: true }).waitFor();
    assert.equal(await visualDialog.getByRole('button', { name: '确认 AI 看图核查', exact: true }).isDisabled(), true, 'uncertain prior requests require the retry acknowledgement');
    await visualDialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(visualReviewRequests, 0, 'cancelled AI confirmation sends no visual request');
    await page.getByRole('button', { name: 'AI 看图核查', exact: true }).click();
    await visualDialog.getByRole('checkbox', { name: '已核查看图服务记录，确认显式重试', exact: true }).check();
    await visualDialog.getByRole('button', { name: '确认 AI 看图核查', exact: true }).click();
    await analysisVisualReview.getByText('AI 看图结果已保存', { exact: true }).waitFor();
    assert.equal(visualReviewRequests, 1); assert.equal(visualPlanReads, 2);
    await analysisVisualReview.locator('summary').click();
    await analysisVisualReview.getByText('本机 AI 看图补查记录，未改公共底稿', { exact: true }).waitFor();
    await analysisVisualReview.getByText('商品对应：匹配 · 产品展示：画面可见', { exact: true }).waitFor();
    await analysisVisualReview.getByText('证据时刻：00:04、00:05.500', { exact: true }).waitFor();
    await page.locator('summary').filter({ hasText: /^分析详情$/ }).click();
    await productCard.getByRole('button', { name: '拼结构', exact: true }).click();
    const panel = page.getByRole('complementary', { name: '公共结构方案' });
    await panel.locator('[data-structure-plan="synthetic-plan-a"]').waitFor();
    const planMediaReview = panel.locator('details[aria-label="方案复用的音画核查"]');
    await planMediaReview.getByText('音画工具结果已保存', { exact: true }).waitFor();
    await planMediaReview.locator('summary').click();
    const planVisualReview = panel.locator('details[aria-label="方案复用的 AI 看图核查"]');
    await planVisualReview.getByText('AI 看图结果已保存', { exact: true }).waitFor();
    await planVisualReview.locator('summary').click();
    await planVisualReview.getByText('本机 AI 看图补查记录，未改公共底稿', { exact: true }).waitFor();
    await planVisualReview.getByText('商品对应：匹配 · 产品展示：画面可见', { exact: true }).waitFor();
    await planVisualReview.getByText('证据时刻：00:04、00:05.500', { exact: true }).waitFor();
    await planVisualReview.getByText('此结果为隔离模拟，不是真实看图判断', { exact: true }).waitFor();
    await planVisualReview.locator('summary').click();
    await planMediaReview.getByText('本机补查记录，未改公共底稿', { exact: true }).waitFor();
    await planMediaReview.getByText('本机检查范围：00:00–00:16', { exact: true }).waitFor();
    await planMediaReview.getByText('音频技术检查：本次讲解整体测量（00:00–00:16） · 峰值 -8 dB · 综合响度 -20.3 LUFS', { exact: true }).waitFor();
    await planMediaReview.getByText('抽帧供画面核对，连续动作未核实；波形和响度是技术检查，原音未核听。', { exact: true }).waitFor();
    await planMediaReview.locator('summary').click();
    assert.equal(await panel.getByRole('button', { name: 'AI 对话', exact: true }).count(), 0, 'the original Layout menu remains the chat control');
    await page.getByRole('button', { name: '布局', exact: true }).click();
    await page.getByRole('dialog', { name: '布局', exact: true }).getByRole('switch', { name: '模拟宿主AI对话', exact: true }).click();
    assert.equal(await page.evaluate(() => window.daocutHost.panel.open), true);
    await page.getByRole('complementary', { name: '模拟宿主AI对话' }).waitFor();
    assert.equal(await page.locator('aside[aria-label="公共结构方案"]').getAttribute('aria-hidden'), 'true');
    await page.getByRole('dialog', { name: '布局', exact: true }).getByRole('switch', { name: '模拟宿主AI对话', exact: true }).click();
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.daocutHost.panel.open), false);
    await panel.getByRole('button', { name: '收起方案', exact: true }).click();
    await page.getByRole('button', { name: '公共方案', exact: true }).click();
    await panel.locator('[data-structure-plan="synthetic-plan-a"]').waitFor();
    assert.deepEqual(await snapshot(project.path), parentBefore, 'mock desktop chat/plan panel toggling never edits the project');
    await panel.getByRole('button', { name: '预览方案 1', exact: true }).click();
    const previewA = page.locator('[data-structure-preview="synthetic-plan-a"]');
    await previewA.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-structure-preview="synthetic-plan-a"] video')?.readyState >= 2);
    await previewA.getByRole('button', { name: '播放方案', exact: true }).click();
    await page.waitForFunction(() => { const video = document.querySelector('[data-structure-preview="synthetic-plan-a"] video'); return video && !video.paused && video.currentTime > 4 && video.currentTime < 7; });
    assert.deepEqual(await snapshot(project.path), parentBefore, 'read-only multi-segment preview must not edit parent film or metadata');
    assert.equal((await listStructureDrafts(project.path)).length, 0, 'preview does not create a draft');
    await panel.getByRole('button', { name: '预览方案 2', exact: true }).click();
    await page.waitForFunction(() => { const video = document.querySelector('[data-structure-preview="synthetic-plan-b"] video'); return video && video.readyState >= 2 && video.currentTime >= 8 && video.currentTime < 10; });
    const previewB = page.locator('[data-structure-preview="synthetic-plan-b"]');
    await page.screenshot({ path: resolve(base, '../structure-preview-browser.png') });
    await previewB.getByRole('button', { name: '播放方案', exact: true }).click();
    await page.waitForFunction(() => { const video = document.querySelector('[data-structure-preview="synthetic-plan-b"] video'); return video && !video.paused && video.currentTime > 4 && video.currentTime < 7; });
    await page.waitForFunction(() => { const video = document.querySelector('[data-structure-preview="synthetic-plan-b"] video'); return video && !video.paused && video.currentTime >= 12 && video.currentTime < 14; });
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-structure-preview="synthetic-plan-b"]'), video = root?.querySelector('video'), position = root?.querySelector('[aria-label="方案播放位置"]');
      return video && video.paused && video.currentTime >= 13.9 && video.currentTime < 14.2 && position?.value === '7000';
    });
    assert.deepEqual(await snapshot(project.path), parentBefore, 'backwards/forwards source transitions and final stop remain read-only');

    await panel.locator('[data-structure-plan="synthetic-plan-a"]').getByRole('button', { name: '编辑副本', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-active-structure-draft]')?.getAttribute('data-active-structure-draft')?.startsWith('sd-'));
    const draftA = created.get('synthetic-plan-a'); assert.ok(draftA);
    assert.equal(await page.locator('[data-active-structure-draft]').getAttribute('data-active-structure-draft'), draftA.project.id);
    const filmA = await api(`/api/projects/${draftA.project.id}`);
    const clipA = filmA.value.tracks[0].clips[0];
    await api(`/api/projects/${draftA.project.id}/edit`, 'POST', { base: filmA.rev, ops: [{ op: 'set', clip: clipA.id, field: 'time', value: [0.5, 1.8] }] });
    const captionsA = await api(`/api/projects/${draftA.project.id}/captions/source?src=assets%2Fsynthetic-live.mp4`);
    captionsA.cues[0].text = '仅草稿A的个人字幕';
    await api(`/api/projects/${draftA.project.id}/captions/source`, 'PUT', { src: 'assets/synthetic-live.mp4', cues: captionsA.cues });
    await api(`/api/projects/${draftA.project.id}/settings`, 'PATCH', { fps: 25 });
    await page.getByRole('button', { name: '字幕样式', exact: true }).last().click();
    const italic = page.locator('[data-subtitle-inspector]').getByRole('button', { name: '斜体', exact: true });
    await italic.scrollIntoViewIfNeeded();
    const expectedItalic = (await italic.getAttribute('aria-pressed')) !== 'true';
    const diskItalicBefore = (await api(`/api/projects/${draftA.project.id}/subtitles`)).style.font.italic;
    let rejectStyleSave = true;
    await page.route(`**/api/projects/${draftA.project.id}/subtitles`, route => route.request().method() === 'PUT' && rejectStyleSave
      ? route.fulfill({ status: 503, json: { error: '模拟字幕样式保存失败' } }) : route.continue());
    const styleChangedAt = Date.now();
    await italic.click();
    await panel.locator('[data-structure-plan="synthetic-plan-b"]').getByRole('button', { name: '编辑副本', exact: true }).click();
    await panel.getByRole('alert').filter({ hasText: '未保存' }).waitFor();
    assert.equal(await page.locator('[data-active-structure-draft]').getAttribute('data-active-structure-draft'), draftA.project.id, 'failed save keeps A mounted');
    assert.equal((await api(`/api/projects/${project.id}/structure-workspace`)).activeProjectId, draftA.project.id);
    assert.equal(created.has('synthetic-plan-b'), false, 'failed save must not create or select B');
    assert.equal((await api(`/api/projects/${draftA.project.id}/subtitles`)).style.font.italic, diskItalicBefore);
    assert.equal(await italic.getAttribute('aria-pressed'), String(expectedItalic), 'the pending UI edit remains available to retry');
    rejectStyleSave = false;
    await panel.locator('[data-structure-plan="synthetic-plan-b"]').getByRole('button', { name: '编辑副本', exact: true }).click();
    await page.waitForFunction(id => document.querySelector('[data-active-structure-draft]')?.getAttribute('data-active-structure-draft') !== id, draftA.project.id);
    const draftB = created.get('synthetic-plan-b'); assert.ok(draftB);
    assert.notEqual(draftB.project.id, draftA.project.id);
    const styleWrite = writes.find(request => request.method === 'PUT' && request.url.endsWith(`/api/projects/${draftA.project.id}/subtitles`) && request.at >= styleChangedAt);
    assert.ok(styleWrite && styleWrite.at - styleChangedAt < 500, 'switching explicitly flushes the UI subtitle edit before the 500ms debounce');
    assert.equal((await api(`/api/projects/${draftA.project.id}/subtitles`)).style.font.italic, expectedItalic);
    const savedA = await Promise.all(['film.html', 'assets/synthetic-live.vtt', '.film/settings.json', '.film/subtitles.json'].map(path => readFile(join(draftA.root, path), 'utf8')));
    assert.equal((await api(`/api/projects/${draftB.project.id}/settings`)).settings.fps, 30);
    assert.equal((await api(`/api/projects/${draftB.project.id}/captions/source?src=assets%2Fsynthetic-live.mp4`)).cues[0].text, '这是合成钩子甲');
    await panel.getByRole('combobox', { name: '我的独立草稿', exact: true }).selectOption(draftA.project.id);
    await page.waitForFunction(id => document.querySelector('[data-active-structure-draft]')?.getAttribute('data-active-structure-draft') === id, draftA.project.id);
    assert.deepEqual(await Promise.all(['film.html', 'assets/synthetic-live.vtt', '.film/settings.json', '.film/subtitles.json'].map(path => readFile(join(draftA.root, path), 'utf8'))), savedA);
    await page.reload();
    await page.waitForFunction(id => document.querySelector('[data-active-structure-draft]')?.getAttribute('data-active-structure-draft') === id, draftA.project.id);
    assert.equal((await api(`/api/projects/${project.id}/structure-workspace`)).activeProjectId, draftA.project.id);
    assert.equal((await api(`/api/projects/${draftA.project.id}/settings`)).settings.fps, 25);
    assert.equal((await api(`/api/projects/${draftA.project.id}/captions/source?src=assets%2Fsynthetic-live.mp4`)).cues[0].text, '仅草稿A的个人字幕');
    assert.equal((await api(`/api/projects/${draftA.project.id}/subtitles`)).style.font.italic, expectedItalic);
    await page.getByRole('button', { name: '商品与结构', exact: true }).click();
    await page.locator('[data-product-card="p"]').waitFor();
    // The mock host starts with chat open on every page load. Reopening preserves
    // that layout, just as initial entry does; explicitly show plans again.
    assert.equal(await page.evaluate(() => window.daocutHost.panel.open), true);
    await page.locator('[data-product-card="p"]').getByRole('button', { name: '拼结构', exact: true }).click();
    await panel.locator('[data-structure-plan="synthetic-plan-a"]').waitFor();
    await planMediaReview.getByText('音画工具结果已保存', { exact: true }).waitFor();
    await planMediaReview.locator('summary').click();
    await planMediaReview.getByText('本机补查记录，未改公共底稿', { exact: true }).waitFor();
    await planMediaReview.getByText('音频技术检查：本次讲解整体测量（00:00–00:16） · 峰值 -8 dB · 综合响度 -20.3 LUFS', { exact: true }).waitFor();
    await planMediaReview.locator('summary').click();
    assert.equal(mediaReviewRequests, 1, 'preview, draft switching and reload reuse the saved media record without rechecking');
    await planVisualReview.getByText('AI 看图结果已保存', { exact: true }).waitFor();
    assert.equal(visualReviewRequests, 1, 'preview, draft switching and reload never resubmit a visual model request');
    await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.readyState >= 2));
    await page.screenshot({ path: resolve(base, '../structure-draft-browser.png') });
    await page.getByRole('button', { name: '返回已有成片', exact: true }).click();
    await page.waitForFunction(id => document.querySelector('[data-active-structure-draft]')?.getAttribute('data-active-structure-draft') === id, project.id);
    assert.equal((await listStructureDrafts(project.path)).length, 2);
    assert.deepEqual(await snapshot(project.path), parentBefore, 'A/B edits, switching and reload preserve all parent business files');
    assert.deepEqual(attemptedModels, []);
    assert.equal(writes.filter(request => /\/exports/.test(request.url)).length, 0);
    assert.deepEqual(browserErrors, []);
    await page.screenshot({ path: join(scratch, 'structure-workspace.png') });
    await page.screenshot({ path: resolve(base, '../structure-workspace-browser.png') });
    await writeFile(join(scratch, 'result.json'), JSON.stringify({ passed: true, parentId: project.id, draftA: draftA.project.id, draftB: draftB.project.id, publicPlansMocked: true, mediaReviewMocked: true, mediaReviewRequests, mediaReviewReads, mediaReviewReusedAfterReload: true, visualReviewMocked: true, visualPlanFromBackend: true, visualReviewRequests, visualPlanReads, visualConfirmationCancelNoRequest: true, visualRetryRequiredAcknowledgement: true, desktopHostMocked: true, sourceSeconds: 16, modelRequests: 0, exportRequests: 0, parentUnchanged: true, failedSaveKeptDraft: true, retryPreservedPendingStyle: true }, null, 2));
  } finally {
    await browser?.close();
    await studio?.close();
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
