// Local-only regression: red public footage, blue private footage, mocked saved
// plans. Uses actual draft/edit APIs; never authorizes models, NAS or exports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';
import { openProject } from './projects.mjs';
import { ensureStructureDraft } from './structure-drafts.mjs';
import { writeProjectFilm } from './film.mjs';

const protectedPaths = ['film.html', 'assets/synthetic-red.mp4', 'assets/synthetic-red.vtt', '.film/product-analysis.json', '.film/settings.json', '.film/subtitles.json'];
const snapshot = async root => Object.fromEntries(await Promise.all(protectedPaths.map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])));

async function fixture(run, { accelerated = false, openDraft = true } = {}) {
  const base = resolve(import.meta.dirname, '../../../../.tmp/structure-preview-focus-browser');
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'case-'));
  const names = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK', 'TEMP', 'TMP'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { DAOCUT_STUDIO_HOME: join(scratch, 'home'), DAOCUT_LIBRARY: join(scratch, 'library'), DAOCUT_TRASH_DIR: join(scratch, 'trash'), DAOCUT_NO_UPDATE_CHECK: '1', TEMP: join(scratch, 'temp'), TMP: join(scratch, 'temp') });
  await Promise.all(['home', 'trash', 'temp'].map(dir => mkdir(join(scratch, dir), { recursive: true })));
  let studio, browser, page, parent, before;
  const forbidden = [], pageErrors = [];
  try {
    studio = await startStudio({ port: 0, ...(process.env.DAOCUT_STRUCTURE_UI ? { editorDir: resolve(process.env.DAOCUT_STRUCTURE_UI) } : {}), openBrowser() {}, authorizeTask: async () => { forbidden.push('authorizeTask'); throw Error('No real task is allowed'); } });
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = await response.json(); assert.equal(response.status, 200, `${path}: ${JSON.stringify(data)}`); return data;
    };
    ({ project: parent } = await api('/api/projects', 'POST', { path: join(scratch, 'parent') }));
    await mkdir(join(parent.path, 'assets'), { recursive: true });
    const makeVideo = (color, output) => execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:size=96x160:rate=10:duration=12`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', output], { windowsHide: true });
    makeVideo('red', join(parent.path, 'assets/synthetic-red.mp4'));
    makeVideo('blue', join(scratch, 'private-blue.mp4'));
    await writeFile(join(parent.path, 'assets/synthetic-red.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n这是红色原片钩子\n\n00:00:04.000 --> 00:00:07.000\n这是完整的核心卖点\n\n00:00:08.000 --> 00:00:10.000\n需要的点击购买\n');
    const scope = { sourceId: 's', productId: 'p', intervalId: 'i', startMs: 0, endMs: 12000 };
    const clips = [
      { candidateId: 'hook', startMs: 0, endMs: 2000, text: '这是红色原片钩子', roles: ['hook'], coreIds: [] },
      { candidateId: 'core', startMs: 4000, endMs: 7000, text: '这是完整的核心卖点', roles: ['core'], coreIds: ['core'] },
      { candidateId: 'close', startMs: 8000, endMs: 10000, text: '需要的点击购买', roles: ['purchase'], coreIds: [] },
    ].map(clip => ({ ...clip, sourceId: 's', assetPath: 'assets/synthetic-red.mp4' }));
    const subCues = [
      [0, 400, '开头铺垫。'], [400, 1700, '这是红色原片钩子。'], [1700, 2000, '补充一句。'],
      [4000, 4300, '我说它好是因为。'], [4300, 6900, '这是完整的核心卖点。'], [6900, 7000, '介绍完了。'],
      [8000, 8300, '看好商品。'], [8300, 9600, '需要的点击购买。'], [9600, 10000, '等下一位。'],
    ];
    if (accelerated) {
      const time = ms => new Date(ms).toISOString().slice(11, 23);
      await writeFile(join(parent.path, 'assets/synthetic-red.vtt'), `WEBVTT\n\n${subCues.map(([start, end, text]) => `${time(start)} --> ${time(end)}\n${text}`).join('\n\n')}\n`);
    }
    const selectedCues = [1, 4, 7];
    const subClips = clips.map((clip, i) => { const cue = selectedCues[i], [startMs, endMs, text] = subCues[cue]; return { ...clip, parentCandidateId: clip.candidateId, cueRange: [cue, cue], startMs, endMs, text, speed: 1.3, tags: clip.roles.map(role => ({ hook: '钩子', core: '卖点', purchase: '行动指令' })[role]) }; });
    const plan = { id: 'focus-plan', version: accelerated ? 'ai-structure-plans-v2' : 'fixture-v1', scope, speed: accelerated ? 1.3 : 1, durationMs: accelerated ? 4000 : 7000, coreIds: ['core'], coreLabels: { core: '完整核心卖点' }, clips: accelerated ? subClips : clips };
    const plans = accelerated ? [plan, { ...plan, id: 'focus-alternative', durationMs: 3000 + 400 / 1.3, clips: [{ ...subClips[0], cueRange: [0, 0], startMs: 0, endMs: 400, text: '开头铺垫。' }, ...subClips.slice(1)] }] : [plan];
    const analysis = { version: 1, sources: [{ id: 's', assetPath: 'assets/synthetic-red.mp4', durationMs: 12000 }], products: [{ id: 'p', name: '隔离合成商品', sourceIds: ['s'] }], intervals: [{ id: 'i', sourceId: 's', productId: 'p', startMs: 0, endMs: 12000 }], candidates: clips.map((clip, index) => ({ ...clip, id: clip.candidateId, productId: 'p', intervalId: 'i', cueRange: [index, index], tags: clip.roles.map(role => ({ hook: '钩子', core: '卖点', purchase: '行动指令' })[role]), origin: 'synthetic-test', version: 1 })) };
    if (accelerated) analysis.candidates = analysis.candidates.map((candidate, i) => ({ ...candidate, cueRange: [i * 3, i * 3 + 2], text: subCues.slice(i * 3, i * 3 + 3).map(cue => cue[2]).join('') }));
    await api(`/api/projects/${parent.id}/product-analysis`, 'PUT', { analysis });
    await writeProjectFilm(parent.path, { stage: { w: 96, h: 160 }, tracks: [{ clips: [{ id: 'original-film', src: 'assets/synthetic-red.mp4', at: 0, time: [10, 11] }] }] });
    await api(`/api/projects/${parent.id}/settings`, 'PATCH', { fps: 30 });
    await api(`/api/projects/${parent.id}/subtitles`, 'PUT', { style: { on: true } });
    before = await snapshot(parent.path);
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (![studio.origin, studio.filmOrigin].includes(url.origin)) return route.abort();
      if (request.method() !== 'GET' && /\/(?:live-analysis|product-workflow|turns|chat|exports|subtitles\/(?:transcribe|translate))(?:\/|$)/.test(url.pathname)) {
        forbidden.push(url.pathname); return route.fulfill({ status: 409, json: { error: 'External work disabled' } });
      }
      return route.continue();
    });
    await page.route('**/live-analysis**', route => {
      if (route.request().method() !== 'GET') { forbidden.push('live-analysis mutation'); return route.fulfill({ status: 409, json: { error: 'No model requests' } }); }
      return route.fulfill({ json: { transcription: { status: 'complete', segments: [] }, analysis: { status: 'complete', intervalId: 'i', productId: 'p', rangeStartMs: 0, rangeEndMs: 12000, stale: false, currentRunId: 'fixture-analysis' } } });
    });
    await page.route('**/structure-plans**', route => {
      if (route.request().method() !== 'GET') { forbidden.push('structure-plans mutation'); return route.fulfill({ status: 409, json: { error: 'Reuse saved plans only' } }); }
      return route.fulfill({ json: { status: 'complete', taskKey: 'fixture-task', context: { ...scope, visibility: 'shared' }, plans, complete: true, generationMethod: 'ai', allValidCombinationsEnumerated: false, materialComplete: true, issues: [] } });
    });
    let draft;
    const drafts = new Map();
    await page.route('**/structure-drafts', async route => {
      const requested = plans.find(item => item.id === route.request().postDataJSON().planId);
      assert.ok(requested, 'only displayed saved plans may become drafts');
      const ensured = await ensureStructureDraft(parent.path, { parentProjectId: parent.id, plan: requested });
      const project = await openProject(ensured.root);
      draft = { ...ensured, project };
      drafts.set(requested.id, draft);
      await route.fulfill({ json: { project, meta: ensured.meta } });
    });
    await page.goto(`${studio.origin}/projects/${parent.id}?key=${studio.key}`);
    const mode = page.getByRole('button', { name: '商品与结构', exact: true });
    if (await mode.count()) await mode.click();
    await page.locator('[data-product-card="p"]').getByRole('button', { name: '拼结构', exact: true }).click();
    const card = page.locator('[data-structure-plan="focus-plan"]');
    await card.waitFor();
    if (openDraft) {
      await card.getByRole('button', { name: '编辑副本', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-active-structure-draft]')?.getAttribute('data-active-structure-draft')?.startsWith('sd-'));
      assert.ok(draft, 'actual private draft was created');
    }
    const preview = async () => {
      await card.getByRole('button', { name: '预览方案 1', exact: true }).click();
      await page.waitForFunction(() => { const video = document.querySelector('[data-structure-preview] video'); return video?.readyState >= 2 && !video.seeking; });
    };
    await run({ page, api, parent, draft, drafts, scratch, preview, plan });
    assert.deepEqual(pageErrors, [], 'no uncaught UI errors');
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: join(scratch, 'failure.png'), fullPage: true }).catch(() => {});
    console.error(`Isolated preview regression artifacts: ${scratch}`);
    throw error;
  } finally {
    try {
      if (before) assert.deepEqual(await snapshot(parent.path), before, 'preview and private edits must not change original film, analysis, subtitles, settings or source');
      assert.deepEqual(forbidden, [], 'never request a model, export or external task');
    } finally {
      await browser?.close(); await studio?.close();
      for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    }
  }
}

const mainRuler = page => page.locator('[data-timeline-scope="main"] [role="slider"][aria-valuemax]').last();
async function seekRuler(ruler, ratio, drag = false) {
  const box = await ruler.boundingBox(); assert.ok(box, 'timeline ruler is visible');
  // The ruler may be wider than its viewport; these short fixtures fit on screen.
  const x = box.x + box.width * ratio, y = box.y + box.height / 2;
  if (drag) { await ruler.page().mouse.move(box.x + 3, y); await ruler.page().mouse.down(); await ruler.page().mouse.move(x, y, { steps: 5 }); await ruler.page().mouse.up(); }
  else await ruler.page().mouse.click(x, y);
}
async function previewClosed(page, reason) {
  try { await page.locator('[data-structure-preview]').waitFor({ state: 'detached', timeout: 2500 }); }
  catch { assert.equal(await page.locator('[data-structure-preview]').count(), 0, reason); }
}
async function blueInFilm(page) {
  const iframe = page.locator('[data-viewer-picture] iframe:visible').last();
  await iframe.waitFor(); const frame = await (await iframe.elementHandle()).contentFrame();
  assert.ok(frame, 'film iframe is available');
  await frame.waitForFunction(() => [...document.querySelectorAll('video')].some(video => {
    if (!video.currentSrc.includes('private-blue.mp4') || video.readyState < 2 || video.seeking || !video.checkVisibility()) return false;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return b > 180 && r < 60 && g < 60;
  }), null, { timeout: 8000 });
  return frame;
}

test('main timeline click/drag exits public preview and plays replacement and added private video', { timeout: 60000 }, async () => fixture(async ({ page, api, draft, scratch, preview }) => {
  await copyFile(join(scratch, 'private-blue.mp4'), join(draft.root, 'assets/private-blue.mp4'));
  const film = await api(`/api/projects/${draft.project.id}`);
  await api(`/api/projects/${draft.project.id}/edit`, 'POST', { base: film.rev, ops: [
    { op: 'set', clip: film.value.tracks[0].clips[0].id, field: 'src', value: 'assets/private-blue.mp4' },
    { op: 'insert', clip: { id: 'private-added', src: 'assets/private-blue.mp4', time: [2, 4] }, at: 7, track: 0 },
  ] });
  await page.reload();
  await page.locator('[data-timeline-scope="main"]').waitFor();
  // Open the saved private draft again after reload; opening the parent never
  // silently overwrites its existing film with a private draft.
  const chooser = page.getByRole('combobox', { name: '我的独立草稿', exact: true });
  if (await chooser.inputValue() !== draft.project.id) await chooser.selectOption(draft.project.id);
  await blueInFilm(page);
  await preview();
  await seekRuler(mainRuler(page), 0.04);
  await previewClosed(page, 'clicking the finished timeline must dismiss the public-plan overlay');
  const frame = await blueInFilm(page);
  const timeBefore = await frame.locator('video[src*="private-blue.mp4"]').first().evaluate(video => video.currentTime);
  await page.keyboard.press('Space');
  await frame.waitForFunction(start => [...document.querySelectorAll('video')].some(video => video.currentSrc.includes('private-blue.mp4') && video.currentTime > start + 0.15), timeBefore);
  await page.keyboard.press('Space');
  await preview();
  // 8/9 of a 9-second film is the separately added blue clip, not the replacement.
  await seekRuler(mainRuler(page), 8 / 9, true);
  await previewClosed(page, 'dragging the finished playhead must dismiss the public-plan overlay');
  await blueInFilm(page);
  const edited = await api(`/api/projects/${draft.project.id}`);
  assert.equal(edited.value.tracks[0].clips[0].src, 'assets/private-blue.mp4');
  assert.ok(edited.value.tracks[0].clips.some(clip => clip.id === 'private-added'));
}));

test('candidate preview and original-source timeline each dismiss the public-plan layer', { timeout: 60000 }, async () => fixture(async ({ page, preview }) => {
  await preview();
  await page.locator('[data-candidate-card="core"]').getByRole('button', { name: '预览', exact: true }).click();
  await previewClosed(page, 'candidate preview must show that source range instead of the previous public plan');
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.currentSrc.includes('synthetic-red.mp4') && video.currentTime >= 4 && video.currentTime <= 7));
  await preview();
  const sourceRuler = page.locator('[data-timeline-scope="source"] [role="slider"][aria-valuemax]').last();
  await seekRuler(sourceRuler, 0.2, true);
  await previewClosed(page, 'dragging the original-source playhead must dismiss the public-plan layer');
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.currentSrc.includes('synthetic-red.mp4') && video.readyState >= 2));
}));

test('Space in public preview controls its own video without advancing the hidden finished timeline', { timeout: 60000 }, async () => fixture(async ({ page, preview }) => {
  await preview();
  const before = await mainRuler(page).getAttribute('aria-valuenow');
  // A noninteractive video receives the click, so this exercises the preview's
  // keyboard ownership rather than a button's native Space activation.
  await page.locator('[data-structure-preview] video').click();
  await page.keyboard.press('Space');
  try { await page.waitForFunction(() => { const video = document.querySelector('[data-structure-preview] video'); return video && !video.paused && video.currentTime > 0.15; }, null, { timeout: 2500 }); }
  catch { assert.equal(await page.locator('[data-structure-preview] video').evaluate(video => !video.paused), true, 'Space in plan preview must play the visible plan video'); }
  assert.equal(await mainRuler(page).getAttribute('aria-valuenow'), before, 'public preview must not advance the hidden private-film clock');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('[data-structure-preview] video')?.paused);
}));

test('Space retains native activation for focused close buttons and plan checkboxes', { timeout: 60000 }, async () => fixture(async ({ page, preview }) => {
  const failures = [];
  await preview();
  const close = page.getByRole('button', { name: '关闭方案预览', exact: true });
  // Give the controls the same focus they receive from Tab, without depending
  // on the unrelated editor toolbar's tab order. All activation is keyboard.
  await close.focus();
  await page.keyboard.press('Space');
  try { await page.locator('[data-structure-preview]').waitFor({ state: 'detached', timeout: 1200 }); }
  catch { failures.push('Space on the focused close button must close the preview'); await close.click(); }

  await preview();
  const selection = page.getByRole('checkbox', { name: '选择方案 1 导出', exact: true });
  assert.equal(await selection.isChecked(), false);
  await selection.focus();
  await page.keyboard.press('Space');
  if (!await selection.isChecked()) failures.push('Space on the focused plan checkbox must select the plan');
  if (!await page.locator('[data-structure-preview] video').evaluate(video => video.paused)) failures.push('Space on a checkbox must not start the plan video');
  assert.deepEqual(failures, [], 'preview shortcuts must preserve native keyboard activation of other controls');
}));

test('structure blocks and full quotes seek their own original segment without editing either film', { timeout: 60000 }, async () => fixture(async ({ page, draft }) => {
  const privatePaths = [...protectedPaths.filter(path => !path.endsWith('.mp4')), 'assets/.daocut-source-media.json', '.film/structure-draft.json'];
  const privateSnapshot = async () => Object.fromEntries(await Promise.all(privatePaths.map(async path => [path, createHash('sha256').update(await readFile(join(draft.root, path))).digest('hex')])));
  const privateBefore = await privateSnapshot();
  const filmClockBefore = await mainRuler(page).getAttribute('aria-valuenow');
  const card = page.locator('[data-structure-plan="focus-plan"]');
  const block = (number, role) => card.getByRole('button', { name: `预览方案 1 第 ${number} 段 ${role}`, exact: true });
  const assertPosition = async (originalSeconds, planMs, reason) => {
    await page.locator('[data-structure-preview] video').waitFor();
    try {
      await page.waitForFunction(({ originalSeconds, planMs }) => {
        const video = document.querySelector('[data-structure-preview] video');
        const position = document.querySelector('input[aria-label="方案播放位置"]');
        return video?.readyState >= 2 && !video.seeking && video.paused && Math.abs(video.currentTime - originalSeconds) < 0.08 && Number(position?.value) === planMs;
      }, { originalSeconds, planMs }, { timeout: 2500 });
    } catch {
      const actual = await page.locator('[data-structure-preview] video').evaluate(video => ({ originalSeconds: video.currentTime, paused: video.paused }));
      assert.ok(actual.paused && Math.abs(actual.originalSeconds - originalSeconds) < 0.08, `${reason}; expected original ${originalSeconds}s paused, got ${JSON.stringify(actual)}`);
      assert.equal(await page.getByRole('slider', { name: '方案播放位置', exact: true }).inputValue(), String(planMs), `${reason}; plan-relative clock must match the selected segment`);
    }
  };
  try {
    // On the pre-fix UI the blocks are spans inside the whole-card button. The
    // fallback reproduces its actual wrong seek (0s) rather than only reporting
    // a missing selector. The corrected UI must expose a keyboard button.
    const core = block(2, '卖点');
    if (await core.count()) await core.click();
    else await card.locator('[aria-label="方案结构"]').getByText('卖点', { exact: true }).click();
    await assertPosition(4, 2000, 'clicking the selling-point block must seek its own source start, not the start of the whole plan');
    assert.equal(await core.count(), 1, 'each structure block must be an independently accessible preview button');

    await block(3, '购买逼单').click();
    await assertPosition(8, 5000, 'the final purchase block must seek 8 seconds in the original');
    await block(1, '钩子').click();
    await assertPosition(0, 0, 'clicking an earlier block in the same plan must seek backwards');
    await core.click();
    await assertPosition(4, 2000, 'returning to the selling point must seek again');
    await page.getByRole('button', { name: '播放方案', exact: true }).click();
    await page.waitForFunction(() => { const video = document.querySelector('[data-structure-preview] video'); return video && !video.paused && video.currentTime > 4.15; });
    await core.click();
    await assertPosition(4, 2000, 'repeated clicks on the current segment must reset it and pause');

    await card.locator('summary').filter({ hasText: '完整原话与来源' }).click();
    await card.getByRole('button', { name: '预览原话 1 第 3 段', exact: true }).click();
    await assertPosition(8, 5000, 'the expanded purchase quote must also seek its source position');
    await card.getByRole('button', { name: '预览原话 1 第 2 段', exact: true }).click();
    await assertPosition(4, 2000, 'the expanded selling-point quote must seek backwards within the same plan');
    assert.equal(await mainRuler(page).getAttribute('aria-valuenow'), filmClockBefore, 'segment preview must not move the private film playhead');
  } finally {
    assert.deepEqual(await privateSnapshot(), privateBefore, 'segment previews must preserve personal film, subtitles, settings, analysis and source references');
  }
}));

test('1.3x subclip preview keeps source boundaries, sequence clock and repeated card seeks aligned', { timeout: 60000 }, async () => fixture(async ({ page, preview }) => {
  const card = page.locator('[data-structure-plan="focus-plan"]');
  await preview();
  const video = page.locator('[data-structure-preview] video');
  assert.equal(await video.evaluate(element => element.playbackRate), 1.3, 'v2 preview must play at the declared 1.3x speed');
  await card.getByText('1.3 倍速', { exact: true }).waitFor();
  await page.getByText('方案预览 · 1.3 倍速 · 不改变下方草稿', { exact: true }).waitFor();
  assert.equal(await video.evaluate(element => element.currentTime), 0.4, 'preview uses the actual ASR subclip start, not its parent candidate start');
  const core = card.getByRole('button', { name: '预览方案 1 第 2 段 卖点', exact: true });
  await core.click();
  await page.waitForFunction(() => { const video = document.querySelector('[data-structure-preview] video'), position = document.querySelector('[aria-label="方案播放位置"]'); return video?.paused && !video.seeking && Math.abs(video.currentTime - 4.3) < 0.01 && Math.abs(Number(position?.value) - 1000) < 0.1; });
  await page.getByRole('slider', { name: '方案播放位置', exact: true }).fill('1500');
  await page.waitForFunction(() => { const video = document.querySelector('[data-structure-preview] video'); return video && !video.seeking && Math.abs(video.currentTime - 4.95) < 0.01; });
  await page.getByRole('button', { name: '播放方案', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-structure-preview] video')?.currentTime > 5.1);
  await core.click();
  await page.waitForFunction(() => { const video = document.querySelector('[data-structure-preview] video'); return video?.paused && !video.seeking && Math.abs(video.currentTime - 4.3) < 0.01 && video.playbackRate === 1.3; });
  await card.locator('summary').filter({ hasText: '完整原话与来源' }).click();
  await card.getByRole('button', { name: '预览原话 1 第 3 段', exact: true }).click();
  await page.waitForFunction(() => { const video = document.querySelector('[data-structure-preview] video'), position = document.querySelector('[aria-label="方案播放位置"]'); return video?.paused && !video.seeking && Math.abs(video.currentTime - 8.3) < 0.01 && Number(position?.value) === 3000; });
  await page.getByRole('button', { name: '播放方案', exact: true }).click();
  await page.waitForFunction(() => { const video = document.querySelector('[data-structure-preview] video'), position = document.querySelector('[aria-label="方案播放位置"]'); return video?.paused && Number(position?.value) === 4000 && video.currentTime >= 9.58 && video.currentTime < 9.8; });
  await card.getByRole('button', { name: '预览方案 1 第 1 段 钩子', exact: true }).click();
  await page.getByRole('button', { name: '播放方案', exact: true }).click();
  await page.waitForFunction(() => { const video = document.querySelector('[data-structure-preview] video'), position = document.querySelector('[aria-label="方案播放位置"]'); return video && !video.paused && video.currentTime >= 4.3 && video.currentTime < 6.9 && Number(position?.value) >= 1000 && Number(position?.value) < 3000 && video.playbackRate === 1.3; });
  await page.getByRole('button', { name: '暂停方案', exact: true }).click();
}, { accelerated: true, openDraft: false }));

test('1.3x private subclip edits, captions and settings survive switching drafts and reopening', { timeout: 60000 }, async () => fixture(async ({ page, api, parent, draft, drafts, preview }) => {
  const filmA = await api(`/api/projects/${draft.project.id}`);
  assert.equal(filmA.value.tracks[0].clips[0].speed, 1.3);
  assert.deepEqual(filmA.value.tracks[0].clips[0].time, [0.4, 1.7]);
  await api(`/api/projects/${draft.project.id}/edit`, 'POST', { base: filmA.rev, ops: [{ op: 'set', clip: filmA.value.tracks[0].clips[0].id, field: 'time', value: [0.6, 1.5] }] });
  const captions = await api(`/api/projects/${draft.project.id}/captions/source?src=assets%2Fsynthetic-red.mp4`);
  captions.cues[1].text = '仅此个人草稿修改的字幕';
  await api(`/api/projects/${draft.project.id}/captions/source`, 'PUT', { src: 'assets/synthetic-red.mp4', cues: captions.cues });
  await api(`/api/projects/${draft.project.id}/settings`, 'PATCH', { fps: 25 });
  const savedFiles = () => Promise.all(['film.html', 'assets/synthetic-red.vtt', '.film/settings.json', '.film/subtitles.json'].map(path => readFile(join(draft.root, path), 'utf8')));
  const savedA = await savedFiles();
  await preview();
  assert.equal(await page.locator('[data-structure-preview] video').evaluate(video => video.currentTime), 0.4, 'public preview remains the original selected subclip despite private trimming');
  await page.locator('[data-structure-plan="focus-alternative"]').getByRole('button', { name: '编辑副本', exact: true }).click();
  await page.waitForFunction(id => document.querySelector('[data-active-structure-draft]')?.getAttribute('data-active-structure-draft') !== id, draft.project.id);
  const second = drafts.get('focus-alternative'); assert.ok(second);
  assert.notEqual(second.project.id, draft.project.id);
  const filmB = await api(`/api/projects/${second.project.id}`);
  assert.equal(filmB.value.tracks[0].clips[0].speed, 1.3);
  assert.deepEqual(filmB.value.tracks[0].clips[0].time, [0, 0.4]);
  assert.equal((await api(`/api/projects/${second.project.id}/settings`)).settings.fps, 30);
  assert.equal((await api(`/api/projects/${second.project.id}/captions/source?src=assets%2Fsynthetic-red.mp4`)).cues[1].text, '这是红色原片钩子。');
  const chooser = page.getByRole('combobox', { name: '我的独立草稿', exact: true });
  await chooser.selectOption(draft.project.id);
  await page.waitForFunction(id => document.querySelector('[data-active-structure-draft]')?.getAttribute('data-active-structure-draft') === id, draft.project.id);
  assert.deepEqual(await savedFiles(), savedA);
  await page.reload();
  await page.waitForFunction(id => document.querySelector('[data-active-structure-draft]')?.getAttribute('data-active-structure-draft') === id, draft.project.id);
  assert.deepEqual(await savedFiles(), savedA, 'reopening must not regenerate or overwrite a modified private subclip draft');
  assert.equal((await api(`/api/projects/${parent.id}/structure-workspace`)).activeProjectId, draft.project.id);
  const reopened = await api(`/api/projects/${draft.project.id}`);
  assert.equal(reopened.value.tracks[0].clips[0].speed, 1.3);
  assert.deepEqual(reopened.value.tracks[0].clips[0].time, [0.6, 1.5]);
  assert.equal((await api(`/api/projects/${draft.project.id}/settings`)).settings.fps, 25);
}, { accelerated: true }));
