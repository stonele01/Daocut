// Real synthetic media + look + desktop bridge + Pi SDK; every provider response is deterministic mock data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createDesktopTextService } from './desktop-analysis-service.mjs';
import { createDesktopAnalysisServices } from '../../../packages/daocut/studio/server/desktop-analysis-services.mjs';
import { createLiveAnalysis } from '../../../packages/daocut/studio/server/live-analysis.mjs';
import { createProductWorkflow } from '../../../packages/daocut/studio/server/product-workflow.mjs';
import { createProductMediaReview } from '../../../packages/daocut/studio/server/product-media-review.mjs';
import { readProductAnalysis, writeProductAnalysis } from '../../../packages/daocut/studio/server/product-analysis.mjs';
import { importSharedProductTranscript } from '../../../packages/daocut/studio/server/product-transcription.mjs';
import { sharedHash } from '../../../packages/daocut/studio/server/shared-analysis.mjs';
import { createStructurePlanInputReader } from '../../../packages/daocut/studio/server/structure-plans.mjs';
import { enumerateStructureCompositions } from '../../../packages/daocut/studio/server/structure-composition.mjs';

const base = resolve(import.meta.dirname, '../../../.tmp/visual-review-desktop-e2e-20261110');
const source = { id: 'synthetic-source', assetPath: 'assets/synthetic.mp4', durationMs: 6000 };
const scope = { sourceId: source.id, productId: 'cup', intervalId: 'first', startMs: 500, endMs: 4500, lectureOnly: true };
const productName = '隔离模拟随行杯';
const cues = [
  { startMs: 500, endMs: 1500, text: '赶车时腾不出手拧杯盖。' },
  { startMs: 1500, endMs: 3000, text: '这款模拟杯可以单手按压打开。' },
  { startMs: 3000, endMs: 4500, text: '需要的确认规格后现在下单。' },
  { startMs: 5000, endMs: 6000, text: '另一次讲解正在介绍另一件商品，不得混入。' },
];
const compact = { schema: 'complete-speech-v1', candidates: [
  { firstCue: 0, lastCue: 0, tags: ['痛点'] }, { firstCue: 1, lastCue: 1, tags: ['卖点'] }, { firstCue: 2, lastCue: 2, tags: ['逼单'] },
], issues: [] };
const textConfig = { id: 'text-mock', name: 'Mock text', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
const visualConfig = { id: 'visualmock', name: 'Existing mock visual model', api: 'openai-completions', baseUrl: 'https://mock.invalid/v1', model: 'mock-vision', levels: ['auto'], effort: 'auto', context: 32768, maxOutputTokens: 1024 };
const sha = value => createHash('sha256').update(value).digest('hex');

async function project(parent, name, copyFrom) {
  const root = join(parent, name); await mkdir(join(root, 'assets'), { recursive: true });
  if (copyFrom) await copyFile(copyFrom, join(root, source.assetPath));
  else execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=96x160:r=10:d=6', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(root, source.assetPath)], { windowsHide: true });
  await writeFile(join(root, 'film.html'), 'existing parent film and personal edits must remain untouched');
  await writeProductAnalysis(root, { version: 1, sources: [source], products: [{ id: 'cup', name: productName, sourceIds: [source.id] }], intervals: [
    { id: 'first', sourceId: source.id, productId: 'cup', startMs: 500, endMs: 4500 },
    { id: 'return', sourceId: source.id, productId: 'cup', startMs: 5000, endMs: 6000 },
  ], candidates: [] });
  await importSharedProductTranscript(root, source, { cues, words: [] }, { schema: 'synthetic-transcript', sha256: sharedHash(cues) });
  return root;
}
async function protectedFiles(root) {
  return Object.fromEntries(await Promise.all(['film.html', source.assetPath].map(async file => { const bytes = await readFile(join(root, file)), info = await stat(join(root, file)); return [file, { sha256: sha(bytes), size: info.size, mtimeMs: info.mtimeMs }]; })));
}

test('confirmed single-product workflow reaches real SDK image wire, persists semantic evidence and reuses it after reopen/share/compose', { timeout: 90000 }, async t => {
  await mkdir(base, { recursive: true }); const scratch = await mkdtemp(join(base, 'case-'));
  t.mock.method(globalThis, 'fetch', () => assert.fail('No real model, ASR or network requests are allowed'));
  const root = await project(scratch, 'origin'), receiver = await project(scratch, 'receiver', join(root, source.assetPath));
  const originalFiles = await protectedFiles(root), receiverFiles = await protectedFiles(receiver);
  let textCalls = 0, visionCalls = 0, toolCalls = 0, imageBytes, requestedVision;
  const roster = { analysisModel: withKey => ({ ...textConfig, ...(withKey ? { apiKey: 'synthetic-text-key' } : {}) }), visualModel: withKey => ({ ...visualConfig, ...(withKey ? { apiKey: 'synthetic-visual-key' } : {}) }) };
  const bridge = createDesktopTextService({ roster: () => roster, fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url) === 'https://api.deepseek.com/responses') {
      textCalls++; const input = JSON.parse(body.input[1].content);
      assert.deepEqual(input.cues, cues.slice(0, 3)); assert.equal(input.productId, scope.productId);
      assert.deepEqual([input.rangeStartMs, input.rangeEndMs], [500, 4500]);
      return new Response(JSON.stringify({ id: 'mock-text-receipt', status: 'completed', usage: { input_tokens: 30, output_tokens: 10 }, output: [{ content: [{ type: 'output_text', text: JSON.stringify(compact) }] }] }));
    }
    assert.equal(String(url), 'https://mock.invalid/v1/chat/completions'); visionCalls++;
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer synthetic-visual-key');
    assert.equal(body.model, visualConfig.model); assert.ok(!body.tools?.length);
    const content = body.messages.find(message => message.role === 'user').content;
    requestedVision = JSON.parse(content.find(block => block.type === 'text').text);
    assert.equal(requestedVision.productName, productName); assert.deepEqual(requestedVision.scope, { startMs: 500, endMs: 4500 });
    assert.deepEqual(requestedVision.candidates.map(candidate => candidate.text), cues.slice(0, 3).map(cue => cue.text));
    assert.ok(requestedVision.frameTimesMs.length > 0 && requestedVision.frameTimesMs.every(time => time >= 500 && time < 4500));
    const imageUrl = content.find(block => block.type === 'image_url').image_url.url;
    assert.ok(imageUrl.startsWith('data:image/png;base64,')); imageBytes = Buffer.from(imageUrl.split(',')[1], 'base64');
    assert.equal(imageBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.ok(imageBytes.length > 100);
    const judgment = { schema: 'product-visual-judgment-v1', findings: requestedVision.candidates.map(candidate => ({ candidate: candidate.candidate,
      productMatch: 'uncertain', display: 'not-shown', evidenceTimesMs: [requestedVision.frameTimesMs.find(time => time >= candidate.startMs && time < candidate.endMs)],
      observation: '模拟语义返回：提供的合成测试色彩图中未见杯子，不能确认商品身份', issues: [] })), issues: [] };
    const chunks = [{ id: 'mock-vision-receipt', object: 'chat.completion.chunk', model: visualConfig.model, choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(judgment) }, finish_reason: null }] },
      { id: 'mock-vision-receipt', object: 'chat.completion.chunk', model: visualConfig.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 92, completion_tokens: 31, total_tokens: 123 } }];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  const localTools = createProductMediaReview();
  const services = createDesktopAnalysisServices({ textBridge: bridge, providersFile: join(scratch, 'no-provider-config.json'), env: {}, mediaReview: async (...args) => { toolCalls++; return localTools(...args); } });
  const create = liveOptions => {
    const live = createLiveAnalysis(liveOptions);
    const workflow = createProductWorkflow({ liveAnalysis: live, discovery: { view: async () => ({ status: 'idle' }) }, analysisServices: services.analysisServices });
    return { live, workflow };
  };
  const { live, workflow } = create(services.liveAnalysis);
  const plan = await workflow.plan(root, { action: 'analysis', ...scope });
  assert.equal(plan.enabled, true, JSON.stringify(plan)); assert.equal(plan.visual.requestCount, 1); assert.equal(plan.requestCount, 2, 'plan must disclose one text and one image request');
  assert.deepEqual([textCalls, visionCalls, toolCalls], [0, 0, 0]);
  await assert.rejects(workflow.execute(root, { confirmed: false, plan }), /确认/); assert.equal(visionCalls, 0);
  await workflow.execute(root, { confirmed: true, plan }); await workflow.wait(root, source.id);
  const state = await live.view(root, source.id, scope.intervalId, scope.productId, scope);
  assert.equal(state.analysis.status, 'complete', JSON.stringify(state.analysis));
  assert.equal(state.analysis.mediaReview.status, 'complete'); assert.equal(state.analysis.visualReview.status, 'complete', JSON.stringify(state.analysis.visualReview));
  assert.deepEqual([textCalls, visionCalls, toolCalls], [1, 1, 1]);
  const media = state.analysis.mediaReview, visual = state.analysis.visualReview;
  assert.equal(media.sourceSha, originalFiles[source.assetPath].sha256); assert.equal(visual.sourceSha, media.sourceSha);
  assert.equal(visual.entries.length, 3); assert.ok(visual.entries.every(entry => entry.productMatch === 'uncertain' && entry.display === 'not-shown'));
  assert.equal(visual.speechVerified, false); assert.equal(visual.continuousActionVerified, false);
  const sheetDir = join(root, '.film/cache/product-media-review', media.key), sheets = await readdir(sheetDir);
  const actualBytes = await readFile(join(sheetDir, sheets.find(name => name.endsWith('.png'))));
  assert.equal(sha(imageBytes), sha(actualBytes), 'the real look artifact bytes must reach the SDK, not a placeholder image');
  const journal = JSON.parse(await readFile(join(root, '.film/visual-review', `${visual.key}.json`), 'utf8'));
  assert.equal(journal.attempts.length, 1); assert.equal(journal.attempts[0].receipt.requestId, 'mock-vision-receipt'); assert.equal(journal.attempts[0].receipt.usage.input, 92);
  assert.equal(JSON.parse(journal.attempts[0].raw).schema, 'product-visual-judgment-v1');
  const payload = await live.exportShared(root, source.id, scope.intervalId); assert.deepEqual(payload.visualReview, visual);
  assert.ok(!JSON.stringify(payload).includes('synthetic-visual-key')); assert.ok(!JSON.stringify(visual).includes(scratch));
  const noRequests = async () => assert.fail('reopen and shared reuse cannot request model or tools again');
  const reopened = create({ ...services.liveAnalysis, modelClient: Object.assign(noRequests, { getCacheIdentity: services.liveAnalysis.modelClient.getCacheIdentity }), mediaReview: noRequests, visualReview: { identity: services.liveAnalysis.visualReview.identity, review: noRequests } });
  const cachedPlan = await reopened.workflow.plan(root, { action: 'analysis', ...scope }); assert.equal(cachedPlan.requestCount, 0); assert.equal(cachedPlan.visual.requestCount, 0);
  await reopened.workflow.execute(root, { confirmed: true, plan: cachedPlan }); await reopened.workflow.wait(root, source.id);
  assert.deepEqual((await reopened.live.view(root, source.id, scope.intervalId, scope.productId, scope)).analysis.visualReview, visual);
  const taskKey = 'f'.repeat(64), snapshot = { action: 'analysis', taskKey, sourceIdentity: media.sourceSha, scope: { startMs: 500, endMs: 4500 }, dataHash: sharedHash({ cues: cues.slice(0, 3), cueIndices: [0, 1, 2] }), payload };
  const result = { sha256: sharedHash(snapshot) };
  await reopened.live.importShared(receiver, source.id, scope, payload, result);
  for (const directory of [root, receiver]) {
    // A hash-verified public-baseline fixture lives only inside these new isolated projects.
    await mkdir(join(directory, '.film/shared-analysis'), { recursive: true });
    await writeFile(join(directory, '.film/shared-analysis', `${taskKey}.json`), JSON.stringify({ sourceId: source.id, status: 'complete', descriptor: { taskKey, sourceIdentity: media.sourceSha, localScope: scope }, result, snapshot }));
    const input = await createStructurePlanInputReader()(directory, scope);
    assert.equal(input.visibility, 'shared', JSON.stringify(input.issues)); assert.deepEqual(input.visualReview, visual); assert.equal(input.visualReviewOrigin, 'shared');
    assert.equal(input.engineInput.visualReview, undefined, 'saved visual evidence must not alter body permutation rules');
    const combinations = enumerateStructureCompositions(input.engineInput, { limit: 50, stepBudget: 1000 });
    assert.ok(combinations.plans.length > 0, JSON.stringify(combinations.issues));
    assert.ok(combinations.plans.every(item => item.clips.every(clip => clip.startMs >= 500 && clip.endMs <= 4500)));
  }
  const reusedPlan = await reopened.workflow.plan(receiver, { action: 'analysis', ...scope }); assert.equal(reusedPlan.requestCount, 0);
  await reopened.workflow.execute(receiver, { confirmed: true, plan: reusedPlan }); await reopened.workflow.wait(receiver, source.id);
  assert.deepEqual((await reopened.live.view(receiver, source.id, scope.intervalId, scope.productId, scope)).analysis.visualReview, visual);
  assert.deepEqual((await readProductAnalysis(receiver)).analysis.candidates.map(candidate => candidate.text), cues.slice(0, 3).map(cue => cue.text));
  assert.deepEqual([textCalls, visionCalls, toolCalls], [1, 1, 1]);
  assert.deepEqual(await protectedFiles(root), originalFiles); assert.deepEqual(await protectedFiles(receiver), receiverFiles);
  await writeFile(join(scratch, 'result.json'), JSON.stringify({ passed: true, mockedTextRequests: textCalls, mockedVisionRequests: visionCalls, localToolCalls: toolCalls, realModelRequests: 0, actualLookImageSha: sha(actualBytes), selectedScope: visual.scope, evidenceReusedByComposition: true, reopenAndImportWithoutResubmission: true, sourceAndParentUnchanged: true }, null, 2));
});
