// Isolated UI regression: all structure states/model returns are mocked; actual
// local draft APIs prove that switching public rules never overwrites editing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';
import { openProject } from './projects.mjs';
import { ensureStructureDraft } from './structure-drafts.mjs';
import { writeProjectFilm } from './film.mjs';

const V1 = 'ai-structure-plans-v1', V2 = 'ai-structure-plans-v2';
const files = ['film.html', 'assets/synthetic.mp4', 'assets/synthetic.vtt', '.film/product-analysis.json', '.film/settings.json', '.film/subtitles.json'];
const snapshot = async (root, privateDraft = false) => Object.fromEntries(await Promise.all((privateDraft ? [...files.filter(name => !name.endsWith('.mp4')), 'assets/.daocut-source-media.json', '.film/structure-draft.json'] : files).map(async name => [name, createHash('sha256').update(await readFile(join(root, name))).digest('hex')])));

async function fixture(run, { colleagueV2 = false, recoverOld = false } = {}) {
  const base = resolve(import.meta.dirname, '../../../../.tmp/structure-rule-entry-20261111/browser');
  await mkdir(base, { recursive: true }); const scratch = await mkdtemp(join(base, 'case-'));
  const names = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK', 'TEMP', 'TMP'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { DAOCUT_STUDIO_HOME: join(scratch, 'home'), DAOCUT_LIBRARY: join(scratch, 'library'), DAOCUT_TRASH_DIR: join(scratch, 'trash'), DAOCUT_NO_UPDATE_CHECK: '1', TEMP: join(scratch, 'temp'), TMP: join(scratch, 'temp') });
  await Promise.all(['home', 'trash', 'temp'].map(dir => mkdir(join(scratch, dir), { recursive: true })));
  let studio, browser, page, parent, parentBefore, oldDraft, privateBefore;
  const requests = [], forbidden = [], errors = [], drafts = new Map();
  let generated = false, completedV2 = colleagueV2, runningReads = 0, oldRecovered = !recoverOld, oldContinued = false;
  try {
    studio = await startStudio({ port: 0, ...(process.env.DAOCUT_STRUCTURE_UI ? { editorDir: resolve(process.env.DAOCUT_STRUCTURE_UI) } : {}), openBrowser() {}, authorizeTask: async () => { forbidden.push('authorizeTask'); throw Error('No real model tasks'); } });
    const api = async (path, method = 'GET', body) => { const response = await fetch(studio.origin + path, { method, headers: { 'x-studio-key': studio.key, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data; };
    ({ project: parent } = await api('/api/projects', 'POST', { path: join(scratch, 'parent') }));
    await mkdir(join(parent.path, 'assets'), { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=96x160:rate=10:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', join(parent.path, 'assets/synthetic.mp4')], { windowsHide: true });
    await writeFile(join(parent.path, 'assets/synthetic.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n完整钩子\n\n00:00:04.000 --> 00:00:07.000\n完整卖点\n\n00:00:08.000 --> 00:00:10.000\n现在下单\n');
    const scope = { sourceId: 's', productId: 'p', intervalId: 'i', startMs: 0, endMs: 12000 };
    const clips = [[0, 2000, '完整钩子', 'hook'], [4000, 7000, '完整卖点', 'core'], [8000, 10000, '现在下单', 'purchase']].map(([startMs, endMs, text, role], i) => ({ sourceId: 's', assetPath: 'assets/synthetic.mp4', candidateId: `c${i}`, startMs, endMs, text, roles: [role], coreIds: role === 'core' ? ['core'] : [] }));
    const oldPlan = { id: 'old-plan', version: V1, scope, speed: 1, durationMs: 7000, coreIds: ['core'], clips };
    const newPlan = { ...oldPlan, id: 'new-plan', version: V2, speed: 1.3, durationMs: 7000 / 1.3, clips: clips.map(clip => ({ ...clip, speed: 1.3 })) };
    const analysis = { version: 1, sources: [{ id: 's', assetPath: 'assets/synthetic.mp4', durationMs: 12000 }], products: [{ id: 'p', name: '隔离商品', sourceIds: ['s'] }], intervals: [{ id: 'i', sourceId: 's', productId: 'p', startMs: 0, endMs: 12000 }], candidates: clips.map((clip, i) => ({ ...clip, id: clip.candidateId, productId: 'p', intervalId: 'i', cueRange: [i, i], tags: [i === 0 ? '钩子' : i === 1 ? '卖点' : '行动指令'], origin: 'synthetic-test', version: 1 })) };
    await api(`/api/projects/${parent.id}/product-analysis`, 'PUT', { analysis });
    await writeProjectFilm(parent.path, { stage: { w: 96, h: 160 }, tracks: [{ clips: [{ id: 'existing-film', src: 'assets/synthetic.mp4', at: 0, time: [10, 11] }] }] });
    await api(`/api/projects/${parent.id}/settings`, 'PATCH', { fps: 30 });
    await api(`/api/projects/${parent.id}/subtitles`, 'PUT', { style: { on: true } });
    parentBefore = await snapshot(parent.path);
    const createDraft = async plan => { const ensured = await ensureStructureDraft(parent.path, { parentProjectId: parent.id, plan }); const project = await openProject(ensured.root); const draft = { ...ensured, project }; drafts.set(plan.id, draft); return draft; };
    oldDraft = await createDraft(oldPlan);
    const film = await api(`/api/projects/${oldDraft.project.id}`);
    await api(`/api/projects/${oldDraft.project.id}/edit`, 'POST', { base: film.rev, ops: [{ op: 'set', clip: film.value.tracks[0].clips[0].id, field: 'time', value: [0.2, 1.8] }] });
    await api(`/api/projects/${oldDraft.project.id}/settings`, 'PATCH', { fps: 25 });
    await api(`/api/projects/${parent.id}/structure-workspace/select`, 'POST', { projectId: oldDraft.project.id });
    privateBefore = await snapshot(oldDraft.root, true);
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } }); page.setDefaultTimeout(6000); page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => { const url = new URL(route.request().url()); if (![studio.origin, studio.filmOrigin].includes(url.origin)) return route.abort(); if (route.request().method() !== 'GET' && /\/(?:live-analysis|product-workflow|turns|chat|exports)(?:\/|$)/.test(url.pathname)) { forbidden.push(url.pathname); return route.abort(); } return route.continue(); });
    await page.route('**/live-analysis**', route => route.fulfill({ json: { transcription: { status: 'complete', segments: [] }, analysis: { status: 'complete', intervalId: 'i', productId: 'p', rangeStartMs: 0, rangeEndMs: 12000, stale: false, currentRunId: 'fixture' } } }));
    const state = (version, status = 'complete') => ({ version, currentRulesVersion: V2, savedVersions: [{ version: V1, taskKey: 'old-task' }, ...(completedV2 || generated ? [{ version: V2, taskKey: 'new-task' }] : [])], status, taskKey: version === V1 ? 'old-task' : 'new-task', context: { ...scope, visibility: 'shared' }, plans: status === 'complete' ? [version === V1 ? oldPlan : newPlan] : [], complete: status === 'complete', generationMethod: 'ai', issues: [], ...(status === 'idle' ? { confirmation: { id: 'new-confirmation', rulesVersion: V2, enabled: true, service: { model: 'mock-only', endpoint: 'https://invalid.example' }, candidateCount: 3, transcriptSegments: 3, visibility: 'shared' } } : {}) });
    await page.route('**/structure-plans**', route => {
      const request = route.request(), url = new URL(request.url()), body = request.method() === 'GET' ? undefined : request.postDataJSON();
      requests.push({ method: request.method(), path: url.pathname, rulesVersion: body?.rulesVersion ?? url.searchParams.get('rulesVersion'), body });
      if (request.method() === 'GET') { const version = url.searchParams.get('rulesVersion') || V1; if (version === V2 && generated && ++runningReads >= 4) completedV2 = true; const value = state(version, version === V1 && !oldRecovered ? 'failed' : version === V2 && !completedV2 ? generated ? 'running' : 'idle' : 'complete'); if (version === V1 && recoverOld) { value.recoverable = !oldRecovered; value.canContinue = oldRecovered && !oldContinued; if (value.canContinue) value.confirmation = { id: 'old-continue', rulesVersion: V1, enabled: true, continuation: true }; } if (colleagueV2 && version === V2) { value.canContinue = true; value.confirmation = { id: 'colleague-continue', rulesVersion: V2, enabled: true, continuation: true }; } return route.fulfill({ json: value }); }
      if (url.pathname.endsWith('/generate')) {
        if (recoverOld && body.rulesVersion === V1) { assert.equal(body.confirmationId, 'old-continue'); assert.equal(body.continue, true); assert.equal(oldContinued, false); oldContinued = true; return route.fulfill({ json: state(V1) }); }
        assert.equal(body.rulesVersion, V2, 'confirmation must submit its exact rules version'); assert.equal(body.confirmationId, 'new-confirmation'); assert.equal(generated, false, 'one confirmation must issue one generate'); generated = true; return route.fulfill({ json: state(V2, 'running') });
      }
      if (url.pathname.endsWith('/recover') && recoverOld) { assert.equal(body.rulesVersion, V1, 'recover must target the viewed old result, not the latest rule default'); oldRecovered = true; return route.fulfill({ json: { ...state(V1), canContinue: true, confirmation: { id: 'old-continue', rulesVersion: V1, enabled: true, continuation: true } } }); }
      forbidden.push(url.pathname); return route.fulfill({ status: 409, json: { error: 'Unplanned structure mutation' } });
    });
    await page.route('**/structure-drafts', async route => { const body = route.request().postDataJSON(); const plan = body.planId === oldPlan.id ? oldPlan : newPlan; assert.equal(body.taskKey, plan === oldPlan ? 'old-task' : 'new-task', 'editing must freeze the displayed version task'); const draft = await createDraft(plan); await route.fulfill({ json: { project: draft.project, meta: draft.meta } }); });
    await page.goto(`${studio.origin}/projects/${parent.id}?key=${studio.key}`);
    if (recoverOld) await page.getByRole('button', { name: '恢复已保存返回', exact: true }).waitFor();
    else await page.locator('[data-structure-plan="old-plan"]').waitFor();
    await run({ page, api, parent, oldDraft, drafts, requests, scratch });
    assert.deepEqual(errors, []);
  } catch (e) { await page?.screenshot({ path: join(scratch, 'failure.png'), fullPage: true }).catch(() => {}); await writeFile(join(scratch, 'requests.json'), JSON.stringify(requests, null, 2)); console.error(`Rules entry fixture: ${scratch}`, e); throw e; }
  finally { try { if (parentBefore) assert.deepEqual(await snapshot(parent.path), parentBefore, 'original film/media/settings/analysis must not change'); if (privateBefore) assert.deepEqual(await snapshot(oldDraft.root, true), privateBefore, 'old private trim/subtitles/settings must survive new public results and switches'); assert.deepEqual(forbidden, []); } finally { await browser?.close(); await studio?.close(); for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } } }
}

test('old complete plans expose new-rule confirmation, preserve cancellation and version-pinned draft editing', { timeout: 60000 }, async () => fixture(async ({ page, oldDraft, drafts, requests }) => {
  const upgrade = page.getByRole('button', { name: '按新版规则拼一版', exact: true });
  await upgrade.waitFor({ timeout: 2500 }).catch(() => {});
  assert.equal(await upgrade.count(), 1, 'a complete v1 result must not hide the approved v2 generation entry');
  await page.screenshot({ path: resolve(import.meta.dirname, '../../../../.tmp/structure-rule-entry-20261111/old-list-entry.png'), fullPage: true });
  const active = () => page.locator('[data-active-structure-draft]').getAttribute('data-active-structure-draft');
  assert.equal(await active(), oldDraft.project.id);
  await upgrade.click();
  const dialog = page.getByRole('dialog', { name: '确认 AI 拼结构' }); await dialog.waitFor();
  assert.match(await dialog.innerText(), /已有.*转写/); assert.match(await dialog.innerText(), /完整小段/); assert.match(await dialog.innerText(), /1\.3/); assert.match(await dialog.innerText(), /30[～–—-]40/); assert.match(await dialog.innerText(), /旧方案.*草稿.*保留/);
  await page.screenshot({ path: resolve(import.meta.dirname, '../../../../.tmp/structure-rule-entry-20261111/new-rules-confirmation.png'), fullPage: true });
  assert.equal(await page.locator('[data-structure-plan="old-plan"]').count(), 1, 'reading a new confirmation must retain the old list');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('[data-structure-plan="old-plan"]').count(), 1);
  assert.equal(requests.filter(r => r.method === 'POST').length, 0, 'cancel must send no generation or recovery request');
  assert.equal(await active(), oldDraft.project.id);
  await upgrade.click(); await dialog.getByRole('button', { name: '确认 AI 拼结构', exact: true }).click();
  await page.getByText('AI 正在拼结构，返回后自动保存；切换或重开只读取进度，不重复发送', { exact: true }).waitFor();
  await page.locator('[data-product-card="p"]').getByRole('button', { name: '拼结构', exact: true }).click();
  await page.getByRole('button', { name: '刷新读取', exact: true }).click();
  await page.locator('[data-structure-plan="new-plan"]').waitFor();
  assert.equal(requests.filter(r => r.path.endsWith('/generate')).length, 1);
  const generatedAt = requests.findIndex(r => r.path.endsWith('/generate'));
  assert.ok(requests.slice(generatedAt + 1).some(r => r.method === 'GET' && r.rulesVersion === V2), 'polling must read the confirmed v2 task');
  await page.getByRole('button', { name: '刷新读取', exact: true }).click();
  await page.waitForTimeout(100); assert.equal(requests.at(-1).rulesVersion, V2, 'refresh stays on new results');
  const versions = page.getByRole('combobox', { name: '方案版本', exact: true });
  assert.equal(await versions.inputValue(), V2);
  await page.screenshot({ path: resolve(import.meta.dirname, '../../../../.tmp/structure-rule-entry-20261111/version-selection.png'), fullPage: true });
  await versions.selectOption(V1); await page.locator('[data-structure-plan="old-plan"]').waitFor();
  assert.equal(await active(), oldDraft.project.id);
  await page.locator('[data-structure-plan="old-plan"]').getByRole('button', { name: '预览方案 1', exact: true }).click();
  await page.getByText('方案预览 · 原速 · 不改变下方草稿', { exact: true }).waitFor();
  await versions.selectOption(V2); await page.locator('[data-structure-plan="new-plan"]').waitFor();
  assert.equal(await page.locator('[data-structure-preview]').count(), 0, 'changing list versions closes its previous preview');
  assert.equal(await active(), oldDraft.project.id, 'public version switches must not select another private film');
  await versions.selectOption(V1); await page.locator('[data-structure-plan="old-plan"]').getByRole('button', { name: '编辑副本', exact: true }).click();
  await page.waitForFunction(id => document.querySelector('[data-active-structure-draft]')?.getAttribute('data-active-structure-draft') === id, oldDraft.project.id);
  await versions.selectOption(V2); await page.locator('[data-structure-plan="new-plan"]').getByRole('button', { name: '编辑副本', exact: true }).click();
  await page.waitForFunction(id => document.querySelector('[data-active-structure-draft]')?.getAttribute('data-active-structure-draft') !== id, oldDraft.project.id);
  assert.ok(drafts.get('new-plan'));
  await page.getByRole('combobox', { name: '我的独立草稿', exact: true }).selectOption(oldDraft.project.id);
  await page.waitForFunction(id => document.querySelector('[data-active-structure-draft]')?.getAttribute('data-active-structure-draft') === id, oldDraft.project.id);
  await page.reload();
  await page.waitForFunction(id => document.querySelector('[data-active-structure-draft]')?.getAttribute('data-active-structure-draft') === id, oldDraft.project.id);
  assert.equal(requests.filter(r => r.path.endsWith('/generate')).length, 1, 'switching and reopening must never regenerate');
}));

test('new-rule entry directly reuses a colleague saved v2 without confirmation or generation', { timeout: 60000 }, async () => fixture(async ({ page, oldDraft, requests }) => {
  await page.getByRole('button', { name: '按新版规则拼一版', exact: true }).click();
  await page.locator('[data-structure-plan="new-plan"]').waitFor();
  assert.equal(await page.getByRole('dialog', { name: '确认 AI 拼结构' }).count(), 0);
  assert.equal(requests.filter(r => r.method === 'POST').length, 0);
  assert.equal(await page.locator('[data-active-structure-draft]').getAttribute('data-active-structure-draft'), oldDraft.project.id);
}, { colleagueV2: true }));

test('recovery and continuation target the selected old rules even when newer results exist', { timeout: 60000 }, async () => fixture(async ({ page, oldDraft, requests }) => {
  await page.getByRole('button', { name: '恢复已保存返回', exact: true }).click();
  await page.locator('[data-structure-plan="old-plan"]').waitFor();
  assert.equal(requests.find(r => r.path.endsWith('/recover'))?.rulesVersion, V1);
  await page.getByRole('button', { name: '继续 AI 拼结构', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '确认 AI 拼结构' }); await dialog.waitFor();
  assert.equal(requests.filter(r => r.path.endsWith('/generate')).length, 0, 'continuation still requires a separate confirmation');
  assert.equal(requests.at(-1).rulesVersion, V1, 'continuation reads the selected rule confirmation');
  await dialog.getByRole('button', { name: '确认 AI 拼结构', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]') && document.querySelector('[data-structure-plan="old-plan"]'));
  assert.equal(requests.filter(r => r.path.endsWith('/generate')).length, 1);
  assert.equal(requests.find(r => r.path.endsWith('/generate'))?.rulesVersion, V1);
  assert.equal(await page.getByRole('combobox', { name: '方案版本', exact: true }).inputValue(), V1);
  assert.equal(await page.locator('[data-active-structure-draft]').getAttribute('data-active-structure-draft'), oldDraft.project.id);
}, { colleagueV2: true, recoverOld: true }));
