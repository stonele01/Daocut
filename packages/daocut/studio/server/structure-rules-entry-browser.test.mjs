// Isolated UI regression: all structure states/model returns are mocked; actual
// local draft APIs prove that opening saved results never overwrites editing.
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

const V1 = 'ai-structure-plans-v1', V2 = 'ai-structure-plans-v2', V3 = 'ai-structure-plans-v3', V4 = 'ai-structure-plans-v4', V5 = 'ai-structure-plans-v5', V6 = 'ai-structure-plans-v6';
const artifactRoot = resolve(process.env.DAOCUT_STRUCTURE_RULES_TEST_ROOT || resolve(import.meta.dirname, '../../../../.tmp/structure-rule-entry-20261111'));
const files = ['film.html', 'assets/synthetic.mp4', 'assets/synthetic.vtt', '.film/product-analysis.json', '.film/settings.json', '.film/subtitles.json'];
const snapshot = async (root, privateDraft = false) => Object.fromEntries(await Promise.all((privateDraft ? [...files.filter(name => !name.endsWith('.mp4')), 'assets/.daocut-source-media.json', '.film/structure-draft.json'] : files).map(async name => [name, createHash('sha256').update(await readFile(join(root, name))).digest('hex')])));

async function fixture(run, { colleagueSaved = false, recoverOld = false, latestVersion = V2, savedV2 = false, initialVersion = V1, openingCoverage, laterBatchStatus, variantScenario = false, variantPassComplete = false, uncoveredOpenings = 0, openDetails = false, fresh = false, reviewScenario = false, feedbackScenario = false } = {}) {
  const base = join(artifactRoot, 'browser');
  await mkdir(base, { recursive: true }); const scratch = await mkdtemp(join(base, 'case-'));
  const names = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK', 'TEMP', 'TMP'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { DAOCUT_STUDIO_HOME: join(scratch, 'home'), DAOCUT_LIBRARY: join(scratch, 'library'), DAOCUT_TRASH_DIR: join(scratch, 'trash'), DAOCUT_NO_UPDATE_CHECK: '1', TEMP: join(scratch, 'temp'), TMP: join(scratch, 'temp') });
  await Promise.all(['home', 'trash', 'temp'].map(dir => mkdir(join(scratch, dir), { recursive: true })));
  let studio, browser, page, parent, parentBefore, oldDraft, privateBefore;
  const requests = [], draftRequests = [], forbidden = [], errors = [], drafts = new Map();
  let useLatest = fresh;
  let generated = false, completedLatest = colleagueSaved, runningReads = 0, oldRecovered = !recoverOld, oldContinued = false;
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
    const newPlan = { ...oldPlan, id: 'new-plan', version: latestVersion, speed: 1.3, durationMs: 7000 / 1.3, clips: clips.map(clip => ({ ...clip, speed: 1.3 })) };
    const v2Plan = { ...newPlan, id: 'v2-plan', version: V2 };
    const seedPlans = variantScenario ? Array.from({ length: 70 }, (_, i) => ({ ...newPlan, id: i ? `seed-plan-${i + 1}` : 'new-plan', version: V4, clips: [{ ...newPlan.clips[0], candidateId: `opening-${i}`, roles: ['hook', i === 0 ? 'offer' : i === 1 ? 'pain' : 'core'], text: i === 0 ? '原价99元现在只要59元' : i === 1 ? '干燥起皮先看这里' : `完整卖点开头${i + 1}` }, ...newPlan.clips.slice(1)] })) : [];
    const addedPlans = variantScenario ? [0, 0, 1].map((opening, i) => ({ ...seedPlans[opening], id: `added-plan-${i + 1}`, version: V5 })) : [];
    const planForVersion = version => variantScenario && [V4, V5].includes(version) ? seedPlans[0] : version === V1 ? oldPlan : version === V2 && latestVersion !== V2 ? v2Plan : newPlan;
    const taskForVersion = version => variantScenario && version === V4 ? 'v4-task' : version === V1 ? 'old-task' : version === V2 && latestVersion !== V2 ? 'v2-task' : 'new-task';
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
    if (feedbackScenario) await page.addInitScript(() => {
      window.__feedbackSubmissions = [];
      const user = { id: 'mock-editor', username: 'editor', name: '模拟剪辑员', role: 'employee' };
      window.daocutHost = { company: {
        state: async () => ({ configured: true, status: 'signed-in', serverUrl: 'https://mock.invalid', user, appVersion: 'test' }),
        onChange: () => () => {}, feedback: async () => ({ feedback: [] }),
        submitFeedback: async input => { window.__feedbackSubmissions.push(input); return { feedback: { ...input, id: 'mock-feedback', userId: user.id, status: 'new' } }; },
      } };
    });
    await page.route('**/*', route => { const url = new URL(route.request().url()); if (![studio.origin, studio.filmOrigin].includes(url.origin)) return route.abort(); if (route.request().method() !== 'GET' && /\/(?:live-analysis|product-workflow|turns|chat|exports)(?:\/|$)/.test(url.pathname)) { forbidden.push(url.pathname); return route.abort(); } return route.continue(); });
    await page.route('**/live-analysis**', route => route.fulfill({ json: { transcription: { status: 'complete', segments: [] }, analysis: { status: 'complete', intervalId: 'i', productId: 'p', rangeStartMs: 0, rangeEndMs: 12000, stale: false, currentRunId: 'fixture' } } }));
    const state = (version, status = 'complete') => {
      if (version === V4 && laterBatchStatus) status = laterBatchStatus;
      const value = { version, currentRulesVersion: latestVersion, savedVersions: [{ version: V1, taskKey: 'old-task' }, ...(savedV2 && latestVersion !== V2 ? [{ version: V2, taskKey: 'v2-task' }] : []), ...(completedLatest || generated ? [{ version: latestVersion, taskKey: 'new-task' }] : [])], status, taskKey: taskForVersion(version), context: { ...scope, visibility: 'shared' }, plans: status === 'complete' ? [planForVersion(version)] : [], complete: status === 'complete', generationMethod: 'ai', issues: [], ...(status === 'idle' ? { confirmation: { id: 'new-confirmation', rulesVersion: latestVersion, enabled: true, service: { model: 'mock-only', endpoint: 'https://invalid.example' }, candidateCount: 3, transcriptSegments: 3, visibility: 'shared' } } : {}) };
      if (version === V6 && status === 'idle') value.confirmation = { ...value.confirmation, openingCount: 35, batchCount: 1, requestCount: 2, existingPlanCount: 0, batchBasis: 'selected-openings' };
      if (version === V4) {
        if (laterBatchStatus) value.plans = [newPlan, { ...newPlan, id: 'unpublished-plan' }];
        value.usablePlanIds = value.plans.filter(plan => plan.id !== 'unpublished-plan').map(plan => plan.id);
      }
      if (variantScenario && [V4, V5].includes(version)) {
        value.savedVersions = [{ version: V1, taskKey: 'old-task' }, { version: V4, taskKey: 'v4-task' }, { version: V5, taskKey: 'new-task' }];
        value.plans = [...seedPlans, ...(version === V5 && generated && completedLatest ? addedPlans : [])];
        value.usablePlanIds = value.plans.map(plan => plan.id);
      }
      if (variantScenario && version === V5) {
        const openingIds = [...seedPlans.map(plan => plan.clips[0].candidateId), ...Array.from({ length: uncoveredOpenings }, (_, i) => `uncovered-${i}`)], finished = variantPassComplete || generated && completedLatest;
        value.coverage = { total: openingIds.length, covered: finished ? openingIds.length : 0, openingCovered: seedPlans.length, openingIds, remainingIds: finished ? [] : openingIds, excluded: [], targetVariants: null, totalVariants: value.plans.length, totalDistinctVariants: value.plans.length, perOpening: openingIds.map(openingId => { const savedCount = value.plans.filter(plan => plan.clips[0].candidateId === openingId).length; return { openingId, savedCount, distinctCount: savedCount, remaining: finished ? 0 : 1 }; }) };
        value.complete = finished; value.canContinue = status === 'complete';
        if (value.canContinue) value.confirmation = { id: 'new-confirmation', rulesVersion: V5, enabled: true, continuation: true, existingPlanCount: value.plans.length, targetVariants: null, openingCount: openingIds.length, batchCount: 9, requestCount: 18, service: { model: 'mock-only', endpoint: 'https://invalid.example' }, visibility: 'shared' };
      }
      if (version === V4 && openingCoverage) {
        const openingIds = Array.from({ length: openingCoverage.total }, (_, i) => `opening-${i}`);
        const covered = status === 'complete' || laterBatchStatus ? openingCoverage.covered : 0;
        value.coverage = { total: openingIds.length, covered, openingIds, remainingIds: openingIds.slice(covered), excluded: [{ id: 'purchase', reason: '购买逼单只用于结尾' }] };
        value.complete = status === 'complete' && !value.coverage.remainingIds.length;
        value.canContinue = status === 'complete' && !!value.coverage.remainingIds.length;
        if (status === 'idle' || value.canContinue) {
          const openingCount = value.coverage.remainingIds.length, batchCount = Math.ceil(openingCount / 8);
          value.confirmation = { id: 'new-confirmation', rulesVersion: V4, enabled: true, continuation: value.canContinue, service: { model: 'mock-only', endpoint: 'https://invalid.example' }, candidateCount: openingIds.length + 1, openingCount, batchCount, requestCount: batchCount * 2, visibility: 'shared' };
        }
      }
      if (reviewScenario && version === V5) {
        value.coverage.excluded = [{ id: 'uncertain', reason: '“八八十单”数量转写不清', startMs: 7000, endMs: 8500 }];
        value.issues = [{ code: 'SAVED_NOTE', message: '本次只收到文字，未检查原音及画面' }];
      }
      return value;
    };
    await page.route('**/structure-plans**', route => {
      const request = route.request(), url = new URL(request.url()), body = request.method() === 'GET' ? undefined : request.postDataJSON();
      requests.push({ method: request.method(), path: url.pathname, rulesVersion: body?.rulesVersion ?? url.searchParams.get('rulesVersion'), body });
      if (request.method() === 'GET') { const version = url.searchParams.get('rulesVersion') || (useLatest ? latestVersion : initialVersion); if (version === latestVersion && generated && ++runningReads >= 4) completedLatest = true; const value = state(version, version === V1 && !oldRecovered ? 'failed' : version === latestVersion && !completedLatest ? generated ? 'running' : 'idle' : 'complete'); if (version === V1 && recoverOld) { value.recoverable = !oldRecovered; value.canContinue = oldRecovered && !oldContinued; if (value.canContinue) value.confirmation = { id: 'old-continue', rulesVersion: V1, enabled: true, continuation: true }; } if (colleagueSaved && value.status === 'complete' && version === latestVersion && ![V4, V5].includes(version)) { value.canContinue = true; value.confirmation = { id: 'colleague-continue', rulesVersion: latestVersion, enabled: true, continuation: true }; } return route.fulfill({ json: value }); }
      if (url.pathname.endsWith('/generate')) {
        if (recoverOld && body.rulesVersion === V1) { assert.equal(body.confirmationId, 'old-continue'); assert.equal(body.continue, true); assert.equal(oldContinued, false); oldContinued = true; return route.fulfill({ json: state(V1) }); }
        assert.equal(body.rulesVersion, latestVersion, 'confirmation must submit its exact rules version'); assert.equal(body.confirmationId, 'new-confirmation'); assert.equal(generated, false, 'one confirmation must issue one generate'); generated = true; if (variantScenario) completedLatest = false; return route.fulfill({ json: state(latestVersion, 'running') });
      }
      if (url.pathname.endsWith('/recover') && recoverOld) { assert.equal(body.rulesVersion, V1, 'recover must target the viewed old result, not the latest rule default'); oldRecovered = true; return route.fulfill({ json: { ...state(V1), canContinue: true, confirmation: { id: 'old-continue', rulesVersion: V1, enabled: true, continuation: true } } }); }
      forbidden.push(url.pathname); return route.fulfill({ status: 409, json: { error: 'Unplanned structure mutation' } });
    });
    await page.route('**/structure-drafts', async route => { const body = route.request().postDataJSON(); draftRequests.push(body); const plan = [...seedPlans, ...addedPlans, oldPlan, v2Plan, newPlan].find(item => item.id === body.planId); assert.ok(plan, 'editing must target a displayed plan'); if (variantScenario && [V4, V5].includes(plan.version)) assert.ok(['v4-task', 'new-task'].includes(body.taskKey)); else assert.equal(body.taskKey, taskForVersion(plan.version), 'editing must freeze the displayed version task'); const draft = await createDraft(plan); await route.fulfill({ json: { project: draft.project, meta: draft.meta } }); });
    await page.goto(`${studio.origin}/projects/${parent.id}?key=${studio.key}`);
    if (recoverOld) await page.getByRole('button', { name: '恢复已保存返回', exact: true }).waitFor();
    else if (fresh) await page.getByRole('complementary', { name: '公共结构方案' }).getByRole('button', { name: '拼结构', exact: true }).waitFor();
    else await page.locator(`[data-structure-plan="${planForVersion(initialVersion).id}"]`).waitFor();

    await run({ page, api, parent, oldDraft, drafts, requests, draftRequests, seedPlans, scratch, completeAnalysis: () => { useLatest = true; completedLatest = false; generated = false; } });
    assert.deepEqual(errors, []);
  } catch (e) { await page?.screenshot({ path: join(scratch, 'failure.png'), fullPage: true }).catch(() => {}); await writeFile(join(scratch, 'requests.json'), JSON.stringify(requests, null, 2)); console.error(`Rules entry fixture: ${scratch}`, e); throw e; }
  finally { try { if (parentBefore) assert.deepEqual(await snapshot(parent.path), parentBefore, 'original film/media/settings/analysis must not change'); if (privateBefore) assert.deepEqual(await snapshot(oldDraft.root, true), privateBefore, 'old private trim/subtitles/settings must survive new public results and switches'); assert.deepEqual(forbidden, []); } finally { await browser?.close(); await studio?.close(); for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } } }
}


test('completed plans have no experiment controls; reopening or clicking compose never requests more variants', { timeout: 60000 }, async () => fixture(async ({ page, requests, draftRequests, oldDraft, seedPlans }) => {
  const panel=page.getByRole('complementary',{name:'公共结构方案'});
  await panel.getByText('70 个开头 · 70 条方案',{exact:true}).waitFor();
  assert.equal(await panel.getByRole('combobox',{name:'方案版本',exact:true}).count(),0);
  assert.equal(await page.getByText(/补充不同方案|按新版规则拼一版|当前档位尚无用量记录/).count(),0);
  await page.getByRole('button',{name:'拼结构',exact:true}).click();
  assert.equal(await page.getByRole('dialog',{name:'确认 AI 拼结构'}).count(),0);
  assert.equal(requests.filter(r=>r.method==='POST').length,0);
  const first=panel.locator('[data-opening-group="opening-0"]');
  await first.click(); await first.click();
  await panel.getByRole('checkbox',{name:'选择方案 1 导出',exact:true}).check();
  await panel.getByRole('combobox',{name:'按开头类型筛选'}).selectOption('痛点共鸣');
  await panel.locator('[data-opening-group="opening-1"]').click();
  await panel.getByRole('checkbox',{name:'选择方案 2 导出',exact:true}).check();
  await panel.getByText('已选 2 条',{exact:true}).waitFor();
  await panel.getByRole('combobox',{name:'按开头类型筛选'}).selectOption('');
  await panel.getByRole('button',{name:'全选全部方案',exact:true}).click();
  await panel.getByText('已选 70 条',{exact:true}).waitFor();
  await panel.getByRole('button',{name:'清空选择',exact:true}).click();
  const card=panel.locator('[data-structure-plan="new-plan"]');
  await card.getByRole('button',{name:'编辑副本',exact:true}).click();
  await page.waitForFunction(id=>document.querySelector('[data-active-structure-draft]')?.getAttribute('data-active-structure-draft')!==id,oldDraft.project.id);
  assert.equal(draftRequests.at(-1).planId,seedPlans[0].id);
  await page.reload(); await panel.getByText('70 个开头 · 70 条方案',{exact:true}).waitFor();
  assert.equal(requests.filter(r=>r.path.endsWith('/generate')).length,0);
  await page.screenshot({path:join(artifactRoot,'production-plans.png'),fullPage:true});
}, {latestVersion:V6,initialVersion:V5,colleagueSaved:true,variantScenario:true,variantPassComplete:true}));

test('fresh composition confirms once without test controls and saves the completed result', {timeout:60000}, async()=>fixture(async({page,requests})=>{
  const panel=page.getByRole('complementary',{name:'公共结构方案'});
  await panel.getByRole('button',{name:'拼结构',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'确认 AI 拼结构'}); await dialog.waitFor();
  assert.match(await dialog.innerText(),/35 个开头/);
  assert.doesNotMatch(await dialog.innerText(),/请求详情|每批|方案版本|补充不同方案|按新版规则/);
  await dialog.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(requests.filter(r=>r.method==='POST').length,0);
  await panel.getByRole('button',{name:'拼结构',exact:true}).click();
  await dialog.getByRole('button',{name:'确认 AI 拼结构',exact:true}).click();
  await panel.locator('[data-structure-plan="new-plan"]').waitFor({timeout:10000});
  assert.equal(await panel.getByRole('button',{name:'拼结构',exact:true}).count(),0);
  assert.equal(requests.filter(r=>r.path.endsWith('/generate')).length,1);
  await page.reload(); await panel.locator('[data-structure-plan="new-plan"]').waitFor();
  assert.equal(requests.filter(r=>r.path.endsWith('/generate')).length,1);
}, {latestVersion:V6,initialVersion:V6,fresh:true}));

test('reanalyze is directly visible and new analysis composition does not remain pinned to old rules', {timeout:60000}, async()=>fixture(async({page,requests,completeAnalysis})=>{
  await page.getByRole('button',{name:'返回工程分析',exact:true}).click();
  await page.getByRole('button',{name:/^重新分析 /}).waitFor();
  const plans=[];
  await page.route('**/product-workflow/plan?**',route=>{ plans.push(new URL(route.request().url())); return route.fulfill({status:409,json:{error:'离线测试：取消本次分析'}}); });
  await page.getByRole('button',{name:/^重新分析 /}).click();
  const dialog=page.getByRole('dialog',{name:'确认分析',exact:true}); await dialog.waitFor();
  await dialog.getByText('离线测试：取消本次分析',{exact:true}).waitFor();
  assert.equal(plans[0].searchParams.get('rerun'),'true');
  await dialog.getByRole('button',{name:'返回任务状态',exact:true}).click();
  completeAnalysis();
  await page.getByRole('button',{name:'拼结构',exact:true}).click();
  const compose=page.getByRole('dialog',{name:'确认 AI 拼结构'}); await compose.waitFor();
  assert.equal(requests.at(-1).rulesVersion,null,'read current analysis, not a frozen v5 selector');
  await compose.getByRole('button',{name:'确认 AI 拼结构',exact:true}).click();
  await page.getByRole('complementary',{name:'公共结构方案'}).locator('[data-structure-plan="new-plan"]').waitFor({timeout:10000});
  assert.deepEqual(requests.filter(r=>r.path.endsWith('/generate')).map(r=>r.rulesVersion),[V6]);
}, {latestVersion:V6,initialVersion:V5,colleagueSaved:true}));
test('technical review reports stay out of the editing panel without changing saved plans or sending requests', { timeout: 60000 }, async () => fixture(async ({ page, requests }) => {
  const panel = page.getByRole('complementary', { name: '公共结构方案' });
  await panel.getByText('70 个开头 · 70 条方案', { exact: true }).waitFor();
  const technical = panel.getByText(/未作开头的原因|分析记录|需核对|未取得抽帧|原音未核听/);
  assert.deepEqual(await technical.allTextContents(), []);
  assert.equal(await panel.getByLabel('方案复用的音画核查').count(), 0);
  assert.equal(await panel.getByLabel('方案复用的 AI 看图核查').count(), 0);
  assert.equal(requests.filter(request => request.method === 'POST').length, 0);
}, { latestVersion: V5, initialVersion: V5, colleagueSaved: true, variantScenario: true, reviewScenario: true }));

test('editor feedback entry and failure button open the company form and submit only after an explicit click', { timeout: 60000 }, async () => fixture(async ({ page, requests }) => {
  await page.getByRole('button', { name: '问题反馈', exact: true }).click();
  const form = page.locator('form').filter({ has: page.locator('textarea[required]') });
  await form.waitFor();
  assert.equal(await page.evaluate(() => window.__feedbackSubmissions.length), 0);
  await page.getByRole('dialog').getByRole('button', { name: '完成', exact: true }).click();
  await form.waitFor({ state: 'hidden' });
  await page.getByRole('complementary', { name: '公共结构方案' }).getByRole('button', { name: '反馈问题', exact: true }).click();
  await form.locator('textarea').waitFor();
  await page.waitForFunction(() => document.querySelector('textarea[required]')?.value.includes('结构方案未完成'));
  assert.equal(await form.locator('input[required]').inputValue(), '结构方案未完成');
  assert.equal(await page.evaluate(() => window.__feedbackSubmissions.length), 0);
  await form.getByRole('switch').first().click();
  await form.locator('button[type="submit"]').click();
  await page.waitForFunction(() => window.__feedbackSubmissions.length === 1);
  const submitted = await page.evaluate(() => window.__feedbackSubmissions[0]);
  assert.equal(submitted.identity.userId, 'mock-editor');
  assert.match(submitted.description, /结构方案未完成/);
  assert.equal(submitted.diagnostics, undefined);
  // The outer setting remains "feedback" while the modal navigates elsewhere.
  // A second error must still switch the inner page and clear its search.
  const settings = page.getByRole('dialog').filter({ has: page.getByRole('textbox', { name: '搜索', exact: true }) });
  await settings.getByRole('button', { name: '通用', exact: true }).click();
  await settings.getByRole('textbox', { name: '搜索', exact: true }).fill('快捷键');
  await page.evaluate(() => window.dispatchEvent(new Event('daocut-feedback-request')));
  await form.waitFor();
  assert.equal(await settings.getByRole('textbox', { name: '搜索', exact: true }).inputValue(), '');
  assert.equal(await page.evaluate(() => window.__feedbackSubmissions.length), 1);
  assert.equal(requests.filter(request => request.method === 'POST').length, 0);
}, { recoverOld: true, feedbackScenario: true }));

