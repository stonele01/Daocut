// Ordinary Studio project + real workflow routes + strictly local synthetic service callbacks.
// All external browser traffic is blocked. This test never reads credentials or invokes a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';
import { readProductTranscript } from './product-transcription.mjs';
import { transcriptPath } from './transcripts.mjs';

test('ordinary existing video uses separately confirmed mock ASR, product discovery and multi-sentence structure, then reopens without new requests', { timeout: 150000 }, async () => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/desktop-live-services-20261104/browser');
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'flow-'));
  const envNames = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK'];
  const old = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  for (const name of envNames.slice(0, 3)) process.env[name] = join(scratch, name);
  process.env.DAOCUT_NO_UPDATE_CHECK = '1';
  await mkdir(process.env.DAOCUT_TRASH_DIR);
  let studio, browser, context, page, step = 'fixture';
  const calls = { asr: 0, discovery: 0, structure: 0 };
  let asrAvailable = true;
  const structureInputs = [];
  const text = [
    '合成甲第一句话。', '合成甲第二句话。', '合成甲第三句话。',
    '合成乙第一句话。', '合成乙第二句话。', '合成乙第三句话。',
    '合成甲返场第一句话。', '合成甲返场第二句话。', '合成甲返场第三句话。',
  ];
  const cues = text.map((line, index) => ({ text: line, startMs: index * 2000 + 100, endMs: index * 2000 + 1900 }));
  const transcriptFile = root => join(root, '.film', 'synthetic-transcript.json');
  const readTranscript = async (root, source) => {
    try { return JSON.parse(await readFile(transcriptFile(root), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return readProductTranscript(root, source); throw error; }
  };
  const start = () => startStudio({ port: 0, editorDir: process.env.DAOCUT_TEST_EDITOR_DIR ? resolve(process.env.DAOCUT_TEST_EDITOR_DIR) : undefined, openBrowser: () => {}, requireAnalysisPlan: true,
    analysisServices: async () => ({
      transcription: { enabled: asrAvailable, provider: 'doubao', name: '豆包语音识别（合成服务）', endpoint: 'local://mock/asr', model: 'synthetic-asr' },
      text: { enabled: true, provider: 'deepseek', name: 'DeepSeek（合成服务）', endpoint: 'local://mock/text', model: 'synthetic-text' },
    }),
    liveAnalysis: {
      readTranscript, modelIdentity: { provider: 'deepseek', model: 'synthetic-text', endpoint: 'local://mock/text' },
      transcribe: async root => {
        calls.asr++;
        const transcript = { cues, words: [], text: text.join('') };
        await mkdir(join(root, '.film'), { recursive: true });
        await writeFile(transcriptFile(root), JSON.stringify(transcript));
        return transcript;
      },
      modelClient: async ({ input }) => {
        calls.structure++;
        const parsed = JSON.parse(input); structureInputs.push(parsed);
        return { candidates: [{ firstCue: parsed.cues[0].index, lastCue: parsed.cues.at(-1).index, tags: ['卖点'], details: { subtypes: [], reason: '合成测试：连续三句话构成一个完整片段', evidence: ['ASR'], context: '', repetition: '', review: ['合成测试，画面待核实'] } }], issues: [] };
      },
    },
    productDiscovery: {
      readTranscript, modelIdentity: { provider: 'deepseek', model: 'synthetic-text', endpoint: 'local://mock/text' },
      modelClient: async () => {
        calls.discovery++;
        return { products: [
          { key: 'a', name: '合成商品甲', variant: '', aliases: [], evidence: [0, 6] },
          { key: 'b', name: '合成商品乙', variant: '', aliases: [], evidence: [3] },
        ], ranges: [
          { key: 'a', firstCue: 0, lastCue: 2, kind: 'lecture', reason: '合成甲讲解', evidence: [0, 1, 2] },
          { key: 'b', firstCue: 3, lastCue: 5, kind: 'lecture', reason: '合成乙讲解', evidence: [3, 4, 5] },
          { key: 'a', firstCue: 6, lastCue: 8, kind: 'lecture', reason: '合成甲返场', evidence: [6, 7, 8] },
        ], issues: [] };
      },
    },
  });
  try {
    studio = await start();
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
    };
    const { project } = await api('/api/projects', 'POST', { path: join(scratch, 'synthetic-existing-project') });
    await mkdir(join(project.path, 'assets'), { recursive: true });
    const assetPath = 'assets/synthetic-existing.mp4', mediaPath = join(project.path, assetPath);
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=18', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=18', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', mediaPath], { windowsHide: true });
    const endpoint = `/api/projects/${project.id}`;
    const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
    const protectedFiles = [mediaPath, join(project.path, 'film.html')];
    const before = await Promise.all(protectedFiles.map(hash));
    const readAnalysis = async () => (await api(`${endpoint}/product-analysis`)).analysis;
    assert.equal((await readAnalysis()).sources.length, 0, 'ordinary project begins with a video but no analysis metadata');
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const open = async (projectId = project.id) => {
      context = await browser.newContext({ viewport: { width: 1680, height: 1150 } });
      const origins = new Set([studio.origin, studio.filmOrigin]);
      await context.route('**/*', route => origins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort());
      page = await context.newPage(); page.setDefaultTimeout(12000);
      await page.goto(`${studio.origin}/projects/${projectId}?key=${studio.key}`);
      await page.getByRole('button', { name: '商品与结构', exact: true }).click();
    };
    await open();
    step = 'register selected existing video without a product list';
    await page.getByRole('button', { name: '准备当前视频', exact: true }).click();
    const preparation = page.getByRole('region', { name: '素材准备', exact: true });
    await preparation.waitFor();
    let analysis = await readAnalysis();
    assert.equal(analysis.sources.length, 1); assert.equal(analysis.sources[0].assetPath, assetPath);
    assert.equal(analysis.products.length, 0, 'source registration does not invent products');
    const sourceId = analysis.sources[0].id;
    assert.deepEqual(calls, { asr: 0, discovery: 0, structure: 0 });
    step = 'cancel audio request plan without calling services';
    await preparation.getByRole('button', { name: '转写', exact: true }).click();
    let confirm = page.getByRole('dialog');
    await confirm.waitFor();
    await confirm.getByText(/新增请求/).waitFor();
    assert.match(await confirm.innerText(), /音频/);
    assert.match(await confirm.innerText(), /请求|次数/);
    assert.match(await confirm.innerText(), /费用|计费/);
    await confirm.getByRole('button', { name: '取消', exact: true }).click();
    assert.deepEqual(calls, { asr: 0, discovery: 0, structure: 0 });
    step = 'confirm audio only, then wait for separate text approval';
    await preparation.getByRole('button', { name: '转写', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认转写', exact: true }).click();
    await preparation.getByRole('button', { name: '拆商品', exact: true }).waitFor();
    assert.deepEqual(calls, { asr: 1, discovery: 0, structure: 0 }, 'audio approval never authorizes text');
    step = 'separate product discovery confirmation saves A/B/A';
    await preparation.getByRole('button', { name: '拆商品', exact: true }).click();
    confirm = page.getByRole('dialog');
    await confirm.getByText(/新增请求/).waitFor();
    assert.match(await confirm.innerText(), /文字|字幕|转写/);
    assert.match(await confirm.innerText(), /费用|计费/);
    assert.equal(calls.discovery, 0);
    await confirm.getByRole('button', { name: '取消', exact: true }).click();
    assert.deepEqual(calls, { asr: 1, discovery: 0, structure: 0 });
    await preparation.getByRole('button', { name: '拆商品', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认拆品', exact: true }).click();
    const products = page.getByLabel('商品列表', { exact: true });
    await products.getByRole('button', { name: /^合成商品甲/ }).waitFor();
    await products.getByRole('button', { name: /^合成商品乙/ }).waitFor();
    analysis = await readAnalysis();
    assert.equal(analysis.products.length, 2); assert.equal(analysis.intervals.length, 3);
    const a = analysis.products.find(product => product.name === '合成商品甲');
    assert.deepEqual(analysis.intervals.filter(interval => interval.productId === a.id).map(interval => [interval.startMs, interval.endMs]), [[100, 5900], [12100, 17900]]);
    assert.deepEqual(calls, { asr: 1, discovery: 1, structure: 0 });
    step = 'single lecture structure requires its own confirmation';
    await products.getByRole('button', { name: /^合成商品甲/ }).click();
    const card = page.locator(`[data-product-card="${a.id}"]`);
    await card.getByRole('button', { name: /^分析 / }).click();
    confirm = page.getByRole('dialog'); await confirm.waitFor();
    await confirm.getByText(/新增请求/).waitFor();
    assert.match(await confirm.innerText(), /00:00\.100|00:00.100/);
    assert.match(await confirm.innerText(), /00:05\.900|00:05.900/);
    assert.equal(calls.structure, 0);
    await confirm.getByRole('button', { name: '取消', exact: true }).click();
    assert.deepEqual(calls, { asr: 1, discovery: 1, structure: 0 });
    await card.getByRole('button', { name: /^分析 / }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认分析', exact: true }).click();
    const fullText = text.slice(0, 3).join('');
    await page.getByLabel('候选片段', { exact: true }).getByText(fullText, { exact: true }).waitFor();
    analysis = await readAnalysis();
    assert.equal(analysis.candidates.length, 1);
    const candidate = analysis.candidates[0];
    assert.deepEqual([candidate.text, candidate.startMs, candidate.endMs, candidate.tags], [fullText, 100, 5900, ['卖点']]);
    assert.deepEqual(structureInputs[0].cues.map(cue => cue.text), text.slice(0, 3), 'only chosen lecture text is sent');
    assert.equal(structureInputs[0].sourceId, sourceId);
    assert.deepEqual(calls, { asr: 1, discovery: 1, structure: 1 });
    step = 'save and reopen with a new local service port and browser environment';
    const oldOrigin = studio.origin;
    await context.close(); context = null;
    await studio.close(); studio = await start();
    assert.notEqual(studio.origin, oldOrigin);
    await open();
    await page.getByLabel('商品列表', { exact: true }).getByRole('button', { name: /^合成商品甲/ }).click();
    await page.getByLabel('候选片段', { exact: true }).getByText(fullText, { exact: true }).waitFor();
    assert.deepEqual(await readAnalysis(), analysis);
    assert.deepEqual(calls, { asr: 1, discovery: 1, structure: 1 }, 'reopening is read-only for services');
    await page.locator(`[data-product-card="${a.id}"]`).getByRole('button', { name: /^已分析 / }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0, 'cached result needs no new paid confirmation');
    assert.deepEqual(await Promise.all(protectedFiles.map(hash)), before, 'original and existing film remain unchanged');
    await page.screenshot({ path: join(base, 'ordinary-workflow.png') });
    step = 'another ordinary project reuses saved transcript even with ASR unavailable';
    await context.close(); context = null;
    asrAvailable = false;
    const { project: reuse } = await api('/api/projects', 'POST', { path: join(scratch, 'synthetic-existing-transcript') });
    await mkdir(join(reuse.path, 'assets'), { recursive: true });
    await copyFile(mediaPath, join(reuse.path, assetPath));
    await mkdir(join(reuse.path, '.film'), { recursive: true });
    await writeFile(transcriptFile(reuse.path), JSON.stringify({ cues, words: [], text: text.join('') }));
    const reuseProtected = [join(reuse.path, assetPath), join(reuse.path, 'film.html')];
    const reuseBefore = await Promise.all(reuseProtected.map(hash));
    await open(reuse.id);
    await page.getByRole('button', { name: '准备当前视频', exact: true }).click();
    const reusePreparation = page.getByRole('region', { name: '素材准备', exact: true });
    await reusePreparation.getByRole('button', { name: '拆商品', exact: true }).waitFor();
    assert.equal(await reusePreparation.getByRole('button', { name: '转写', exact: true }).count(), 0);
    assert.deepEqual(calls, { asr: 1, discovery: 1, structure: 1 });
    await reusePreparation.getByRole('button', { name: '拆商品', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认拆品', exact: true }).click();
    await page.getByLabel('商品列表', { exact: true }).getByRole('button', { name: /^合成商品甲/ }).waitFor();
    assert.deepEqual(calls, { asr: 1, discovery: 2, structure: 1 }, 'saved transcript bypasses unavailable ASR');
    assert.deepEqual(await Promise.all(reuseProtected.map(hash)), reuseBefore);
    step = 'local VTT requires explicit provenance confirmation, then reopens without ASR';
    await context.close(); context = null;
    const { project: sidecar } = await api('/api/projects', 'POST', { path: join(scratch, 'synthetic-existing-vtt') });
    await mkdir(join(sidecar.path, 'assets'), { recursive: true });
    const sidecarMedia = join(sidecar.path, assetPath), vttPath = join(sidecar.path, transcriptPath(assetPath));
    await copyFile(mediaPath, sidecarMedia);
    const stamp = ms => `00:00:${(ms / 1000).toFixed(3).padStart(6, '0')}`;
    await writeFile(vttPath, `WEBVTT\n\n${cues.map(cue => `${stamp(cue.startMs)} --> ${stamp(cue.endMs)}\n${cue.text}\n`).join('\n')}`);
    // Copying a video can give it a newer mtime than its valid subtitle: explicit binding must still work.
    const earlier = new Date((await stat(sidecarMedia)).mtimeMs - 2000);
    await utimes(vttPath, earlier, earlier);
    const sidecarProtected = [sidecarMedia, vttPath, join(sidecar.path, 'film.html')];
    const sidecarBefore = await Promise.all(sidecarProtected.map(hash));
    await open(sidecar.id);
    await page.getByRole('button', { name: '准备当前视频', exact: true }).click();
    let sidecarPreparation = page.getByRole('region', { name: '素材准备', exact: true });
    const bind = sidecarPreparation.getByRole('button', { name: '确认这些字幕属于此原片', exact: true });
    await bind.waitFor();
    assert.equal(await sidecarPreparation.getByRole('button', { name: '拆商品', exact: true }).count(), 0, 'unconfirmed sidecar is not silently reused');
    assert.deepEqual(calls, { asr: 1, discovery: 2, structure: 1 });
    await bind.click();
    await sidecarPreparation.getByRole('button', { name: '拆商品', exact: true }).waitFor();
    assert.deepEqual(calls, { asr: 1, discovery: 2, structure: 1 }, 'provenance confirmation is local and never uploads audio');
    await context.close(); context = null;
    await open(sidecar.id);
    sidecarPreparation = page.getByRole('region', { name: '素材准备', exact: true });
    await sidecarPreparation.getByRole('button', { name: '拆商品', exact: true }).waitFor();
    assert.equal(await sidecarPreparation.getByRole('button', { name: '确认这些字幕属于此原片', exact: true }).count(), 0, 'saved provenance survives fresh browser');
    await sidecarPreparation.getByRole('button', { name: '拆商品', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认拆品', exact: true }).click();
    await page.getByLabel('商品列表', { exact: true }).getByRole('button', { name: /^合成商品甲/ }).waitFor();
    assert.deepEqual(calls, { asr: 1, discovery: 3, structure: 1 });
    assert.deepEqual(await Promise.all(sidecarProtected.map(hash)), sidecarBefore);
    step = 'existing product ranges do not hide missing transcript preparation';
    await context.close(); context = null; asrAvailable = true;
    const { project: missingTranscript } = await api('/api/projects', 'POST', { path: join(scratch, 'synthetic-ranges-without-transcript') });
    await mkdir(join(missingTranscript.path, 'assets'), { recursive: true });
    await copyFile(mediaPath, join(missingTranscript.path, assetPath));
    const existingCuts = { version: 1, sources: [{ id: 's', assetPath, durationMs: 18000 }], products: [{ id: 'p', name: '已保存商品', sourceIds: ['s'] }], intervals: [{ id: 'i', sourceId: 's', productId: 'p', startMs: 100, endMs: 5900 }], candidates: [] };
    await api(`/api/projects/${missingTranscript.id}/product-analysis`, 'PUT', { analysis: existingCuts });
    await open(missingTranscript.id);
    const missingPanel = page.getByLabel('直播拆品设置', { exact: true });
    if (!await missingPanel.evaluate(element => element.open)) await missingPanel.locator('summary').first().click();
    await missingPanel.getByRole('region', { name: '素材准备', exact: true }).getByRole('button', { name: '转写', exact: true }).click();
    const missingDialog = page.getByRole('dialog', { name: '确认转写', exact: true });
    await missingDialog.getByText(/新增请求/).waitFor();
    await missingDialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.deepEqual(calls, { asr: 1, discovery: 3, structure: 1 });
    const retainedCuts = (await api(`/api/projects/${missingTranscript.id}/product-analysis`)).analysis;
    assert.deepEqual(retainedCuts.products, existingCuts.products); assert.deepEqual(retainedCuts.intervals, existingCuts.intervals);
    await writeFile(join(base, 'result.json'), `${JSON.stringify({ synthetic: true, calls, products: analysis.products.length, intervals: analysis.intervals.length, candidate: { text: candidate.text, startMs: candidate.startMs, endMs: candidate.endMs }, separateConfirmations: true, newBrowserAndPort: true, protectedFilesUnchanged: true, savedTranscriptWithoutAsr: true, localVttRequiresBinding: true, olderVttBindingSurvivesReopen: true, existingCutsCanPrepareTranscript: true }, null, 2)}\n`);
  } catch (error) {
    await page?.screenshot({ path: join(base, 'failure.png') }).catch(() => {});
    throw new Error(`Ordinary live workflow failed at ${step}: ${error.message}`, { cause: error });
  } finally {
    await context?.close(); await browser?.close(); await studio?.close();
    for (const name of envNames) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
    const child = relative(base, scratch); assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
